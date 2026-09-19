// Play-credit accounting for the hosted Worker. Pure logic: storage, the Jev
// call and the global guard are injected, so this runs under `node --test`.
//
// Concurrency model: one in-memory `state` object per account is the source of
// truth (a Durable Object is single-threaded and loads it once under
// blockConcurrencyWhile). Every check-and-mutate below is synchronous, and each
// mutation is written through with `storage.put` before the request continues.
// Awaiting Jev deliberately lets a second request interleave (2 in flight);
// both then work on the same object, so neither can overdraw the other.
//
// All money is a safe integer of nanodollars (1 USD = 1e9).
const NANO = 1e9;
const REQUEST_ID = /^[a-zA-Z0-9-]{16,80}$/,
  USER_ID = /^(gh|gg)_[a-zA-Z0-9]{1,64}$/,
  ORDER_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
export const PAYLOAD_CAP_BYTES = 48_000,
  RESERVE_OVERHEAD_TOKENS = 2048,
  MAX_IN_FLIGHT = 2,
  MIN_SPACING_MS = 100,
  RECEIPTS_KEPT = 16,
  ORDERS_KEPT = 1000;
const BAD_REQUEST =
    "A valid shared state, 1-12 player decisions and a request_id are required.",
  UNAVAILABLE = "Jev is temporarily unavailable.";

const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const amount = (v) => Number.isSafeInteger(v) && v > 0;
const reply = (status, body) => ({ status, body });

export function usdToNano(value, fallback) {
  const usd = Number(value ?? fallback);
  const nano = Math.round(usd * NANO);
  if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(nano))
    throw new Error("Invalid USD amount in configuration.");
  return nano;
}

// ceil(tokens × USD-per-million-tokens × 1000) nanodollars. The price is first
// fixed to a whole number of micro-nanodollars per token so float fuzz
// (0.042 × 1000 × n) can never add a phantom nanodollar.
export function tokenCost(tokens, pricePerMTok) {
  const cost = Math.ceil((tokens * Math.round(pricePerMTok * 1e6)) / 1000);
  if (!Number.isSafeInteger(cost) || cost < 0)
    throw new Error("Token cost is out of range.");
  return cost;
}

export const reservationFor = (bytes, pricePerMTok) =>
  tokenCost(bytes / 2 + RESERVE_OVERHEAD_TOKENS, pricePerMTok);

function failure(error, settled) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return reply(502, {
      error: "Jev timed out. Players used the local policy.",
    });
  if (!settled && error?.status === 400)
    return reply(400, { error: BAD_REQUEST });
  if (error?.status === 429)
    return reply(429, {
      error: "Jev is busy. Players use the local policy for a moment.",
    });
  // Upstream 401/402 are the operator's problem and never the player's
  // session or credit, so they must not surface as 401/402 here.
  return reply(502, { error: UNAVAILABLE });
}

export class Ledger {
  constructor({ storage, env, evaluate, prepare, guard, now = Date.now }) {
    Object.assign(this, { storage, env, evaluate, prepare, guard, now });
    this.state = null;
    this.inflight = new Map(); // request id → nanodollars currently held
    this.lastStart = -Infinity;
  }

  async load() {
    const stored = await this.storage.get("state");
    this.state = {
      user: null,
      granted: 0,
      purchased: 0,
      spent: 0,
      refund_shortfall: 0,
      pending: {},
      receipts: [],
      orders: {},
      ...(object(stored) ? stored : {}),
    };
    // A reservation that outlived its Durable Object has an unknown outcome:
    // Jev may have billed it, so it becomes a kept debit, never a refund.
    const interrupted = Object.entries(this.state.pending);
    if (!interrupted.length) return;
    this.state.pending = {};
    for (const [id, reserved] of interrupted) {
      this.state.spent += reserved;
      await this.#receipt(
        id,
        reply(502, {
          error: "Jev was interrupted. Players used the local policy.",
        }),
      );
    }
    await this.#save();
  }

  async initialize(identity) {
    if (
      !object(identity) ||
      typeof identity.id !== "string" ||
      !USER_ID.test(identity.id) ||
      !["github", "google"].includes(identity.provider) ||
      identity.id.startsWith("gh_") !== (identity.provider === "github")
    )
      throw new Error("Invalid identity.");
    const user = {
      id: identity.id,
      name:
        typeof identity.name === "string"
          ? identity.name.slice(0, 160)
          : "Player",
      avatar_url:
        typeof identity.avatar_url === "string" ? identity.avatar_url : null,
      provider: identity.provider,
    };
    const state = this.state;
    if (state.user && state.user.id !== user.id)
      throw new Error("This account belongs to another identity.");
    // The grant happens exactly once, when the account is created.
    if (!state.user) state.granted = usdToNano(this.env.PLAY_GRANT_USD, 0.1);
    state.user = user;
    await this.#save();
    return this.snapshot();
  }

  snapshot() {
    return this.state.user
      ? { user: { ...this.state.user }, credits: this.credits() }
      : null;
  }

  #remaining() {
    const s = this.state;
    let held = 0;
    for (const n of this.inflight.values()) held += n;
    return s.granted + s.purchased - s.spent - held;
  }

  credits() {
    const s = this.state,
      remaining = this.#remaining();
    // Exhausted = the largest request the server accepts is no longer covered,
    // so `exhausted: false` guarantees the next decide is not a 402.
    let worst = 0;
    try {
      worst = reservationFor(PAYLOAD_CAP_BYTES, this.#price() ?? 0);
    } catch {}
    return {
      granted_usd: s.granted / NANO,
      purchased_usd: s.purchased / NANO,
      // What has not been charged yet. It only ever goes down (or up on a
      // top-up): worst-case holds of requests still in flight are not counted
      // here, or the readout would dip on every call and climb back when the
      // call settles to its real, smaller cost.
      remaining_usd: (s.granted + s.purchased - s.spent) / NANO,
      // What a new request can reserve right now: remaining minus those holds.
      available_usd: remaining / NANO,
      spent_usd: s.spent / NANO,
      exhausted: remaining < worst,
    };
  }

  // USD per million input tokens, or null when pricing is unusable. Output is
  // unbounded, so a non-zero output price cannot be reserved for: reject.
  #price() {
    const input = Number(this.env.JEV_INPUT_PRICE ?? 0.042),
      output = Number(this.env.JEV_OUTPUT_PRICE ?? 0);
    return Number.isFinite(input) && input >= 0 && input <= 1e4 && output === 0
      ? input
      : null;
  }

  #save() {
    return this.storage.put("state", structuredClone(this.state));
  }

  async #receipt(id, { status, body }) {
    // The echoed prompt is inspector detail, up to 48 kB: not worth keeping.
    const kept = "request" in body ? { ...body, request: null } : body;
    await this.storage.put(`receipt:${id}`, { status, body: kept });
    this.state.receipts.push(id);
    while (this.state.receipts.length > RECEIPTS_KEPT)
      await this.storage.delete?.(`receipt:${this.state.receipts.shift()}`);
  }

  async decide(body) {
    const state = this.state;
    if (!state.user)
      return reply(401, {
        error: "Sign in to play with Jev.",
        auth_required: true,
      });
    const id = object(body) ? body.request_id : null;
    if (typeof id !== "string" || !REQUEST_ID.test(id))
      return reply(400, { error: BAD_REQUEST });

    // 1. A repeated id is answered from its receipt: retries never pay twice.
    if (state.receipts.includes(id)) {
      const receipt = await this.storage.get(`receipt:${id}`);
      return receipt
        ? reply(receipt.status, { ...receipt.body, credits: this.credits() })
        : reply(502, { error: UNAVAILABLE, credits: this.credits() });
    }

    // 2. Everything from here to the reservation is synchronous.
    if (this.inflight.has(id))
      return reply(429, { error: "This request is already in progress." });
    if (this.inflight.size >= MAX_IN_FLIGHT)
      return reply(429, { error: "Too many active Jev requests." });
    const now = this.now();
    if (now - this.lastStart < MIN_SPACING_MS)
      return reply(429, { error: "Too many Jev requests. Slow down." });
    const price = this.#price();
    if (price === null) {
      console.error(
        "ledger: JEV_INPUT_PRICE invalid or JEV_OUTPUT_PRICE not 0",
      );
      return reply(503, { error: UNAVAILABLE });
    }
    if (!this.env.TYPESAFE_API_KEY) return reply(503, { error: UNAVAILABLE });

    // 3. Build the real payload and reserve its pessimistic worst case.
    let built, apiCall, bytes;
    try {
      built = this.prepare(body);
      const questions = built.prepared?.request?.questions;
      apiCall = questions ? Object.keys(questions).length > 0 : true;
      bytes = Number.isFinite(built.bytes)
        ? built.bytes
        : new TextEncoder().encode(built.payload).length;
    } catch {
      return reply(400, { error: BAD_REQUEST });
    }
    if (bytes > PAYLOAD_CAP_BYTES)
      return reply(413, { error: "Decision batch is too large." });
    const reserved = apiCall ? reservationFor(bytes, price) : 0;
    if (reserved > this.#remaining())
      return reply(402, {
        error: "Play credit is used up. Players use the local policy.",
        code: "credit_exhausted",
        credits: this.credits(),
      });
    this.inflight.set(id, reserved);
    this.lastStart = now;

    let persisted = false,
      settled = false;
    // Moves this request's hold into `spent`. The in-flight slot stays taken
    // (holding 0) until the receipt exists, so a fast retry cannot slip between.
    const close = async (billed, charge) => {
      settled = true;
      this.inflight.set(id, 0);
      delete state.pending[id];
      state.spent += charge;
      await this.#save();
      if (reserved > 0)
        try {
          await this.guard.settle(reserved, billed);
        } catch (e) {
          console.error("ledger: guard settle failed", e?.message);
        }
    };
    const onUsage = async (usage) => {
      if (settled) return;
      const tokens = usage?.input_tokens;
      if (!Number.isFinite(tokens) || tokens < 0) return; // unknown: hold stays
      const billed = tokenCost(tokens, price);
      if (billed > reserved)
        console.error(
          `ledger: usage ${billed} exceeded reservation ${reserved}`,
        );
      // `#remaining()` already excludes this hold, so the charge cannot
      // exceed what the account really has.
      await close(billed, Math.min(billed, reserved + this.#remaining()));
    };

    try {
      // 4. The global daily cap sees the same reservation.
      if (reserved > 0) {
        let allowed;
        try {
          allowed = await this.guard.reserve(reserved);
        } catch (e) {
          console.error("ledger: guard unreachable", e?.message);
          return reply(503, { error: UNAVAILABLE });
        }
        if (!allowed)
          return reply(503, {
            error: "Jev is resting for today. Players use the local policy.",
            code: "daily_cap",
          });
      }
      // 5. Persist the hold, call Jev, settle on its reported usage.
      state.pending[id] = reserved;
      persisted = true;
      await this.#save();
      let result;
      try {
        result = await this.evaluate(body, this.env, undefined, onUsage, built);
        if (!settled) await onUsage(result?.usage);
        if (!settled) throw new Error("Jev reported no usage.");
      } catch (e) {
        console.error(
          "ledger: Jev call failed:",
          e?.name,
          e?.status,
          e?.message,
        );
        const answer = failure(e, settled);
        if (!settled && (e?.billable === false || e?.status === 400)) {
          // 6a. Certainly unbilled (refused before any work): full refund,
          // and no receipt so the same batch may be retried.
          this.inflight.set(id, 0);
          delete state.pending[id];
          await this.#save();
          if (reserved > 0)
            try {
              await this.guard.settle(reserved, 0);
            } catch {}
          answer.body.credits = this.credits();
          return answer;
        }
        // 6b. Timeout / 5xx / anything unknown: the reservation is kept.
        if (!settled) await close(reserved, reserved);
        await this.#receipt(id, answer);
        await this.#save();
        answer.body.credits = this.credits();
        return answer;
      }
      const answer = reply(200, result);
      await this.#receipt(id, answer);
      await this.#save();
      return reply(200, { ...result, credits: this.credits() });
    } finally {
      this.inflight.delete(id);
      if (!persisted) delete state.pending[id];
    }
  }

  // Credits an account; today the owner calls it via POST /api/admin/topup.
  async topUp({ amount_nanodollars, order_id, source } = {}) {
    const state = this.state;
    if (!state.user) throw new Error("Unknown account.");
    if (!amount(amount_nanodollars))
      throw new Error("amount_nanodollars must be a positive safe integer.");
    if (typeof order_id !== "string" || !ORDER_ID.test(order_id))
      throw new Error("Invalid order_id.");
    if (state.orders[order_id])
      return { applied: false, credits: this.credits() };
    const purchased = state.purchased + amount_nanodollars;
    if (!Number.isSafeInteger(purchased + state.granted))
      throw new Error("Balance is out of range.");
    const ids = Object.keys(state.orders);
    if (ids.length >= ORDERS_KEPT) delete state.orders[ids[0]];
    state.orders[order_id] = {
      amount: amount_nanodollars,
      source: typeof source === "string" ? source.slice(0, 40) : "manual",
      at: this.now(),
    };
    state.purchased = purchased;
    await this.#save();
    return { applied: true, credits: this.credits() };
  }

  // Undoes a topUp (e.g. one credited by mistake), once per order.
  // Takes back at most what is still unspent; the rest is the shortfall.
  async reverseTopUp({ order_id, amount_nanodollars } = {}) {
    const state = this.state;
    if (!state.user) throw new Error("Unknown account.");
    if (!amount(amount_nanodollars))
      throw new Error("amount_nanodollars must be a positive safe integer.");
    const order =
      typeof order_id === "string" && Object.hasOwn(state.orders, order_id)
        ? state.orders[order_id]
        : null;
    if (!order) throw new Error("Unknown order_id.");
    if (!order.reversed) {
      if (amount_nanodollars > order.amount)
        throw new Error("A reversal cannot exceed the order amount.");
      const removed = Math.max(
        0,
        Math.min(amount_nanodollars, this.#remaining(), state.purchased),
      );
      const shortfall = amount_nanodollars - removed;
      state.purchased -= removed;
      state.refund_shortfall += shortfall;
      order.reversed = { removed, shortfall, at: this.now() };
      await this.#save();
    }
    return {
      removed_nanodollars: order.reversed.removed,
      shortfall_nanodollars: order.reversed.shortfall,
      credits: this.credits(),
    };
  }
}

// Global spend cap: reserved + spent nanodollars for the current UTC day.
export class DailyGuard {
  constructor({ storage, env, now = Date.now }) {
    Object.assign(this, { storage, env, now });
    this.state = null;
  }

  async load() {
    const stored = await this.storage.get("day");
    this.state = object(stored) ? stored : { day: "", reserved: 0, spent: 0 };
  }

  #roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.state.day !== day) this.state = { day, reserved: 0, spent: 0 };
  }

  #save() {
    return this.storage.put("day", { ...this.state });
  }

  // Check-and-add is synchronous, so two accounts cannot both take the last slice.
  async reserve(n) {
    if (!Number.isSafeInteger(n) || n < 0) return false;
    let cap;
    try {
      cap = usdToNano(this.env.DAILY_CAP_USD, 5);
    } catch {
      return false; // an unreadable cap spends nothing
    }
    this.#roll();
    if (this.state.reserved + this.state.spent + n > cap) return false;
    this.state.reserved += n;
    await this.#save();
    return true;
  }

  // A reservation from before midnight only adds its actual spend to today.
  async settle(reserved, actual) {
    if (
      !Number.isSafeInteger(reserved) ||
      reserved < 0 ||
      !Number.isSafeInteger(actual) ||
      actual < 0
    )
      return this.snapshot();
    this.#roll();
    this.state.reserved = Math.max(0, this.state.reserved - reserved);
    this.state.spent += actual;
    await this.#save();
    return this.snapshot();
  }

  snapshot() {
    this.#roll();
    return { ...this.state };
  }
}
