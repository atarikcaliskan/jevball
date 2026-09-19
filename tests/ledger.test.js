import test from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  DailyGuard,
  tokenCost,
  reservationFor,
  usdToNano,
} from "../server/ledger.js";

const IDENTITY = {
  id: "gh_42",
  name: "Ada",
  avatar_url: "https://avatars.githubusercontent.com/u/42",
  provider: "github",
};
const ENV = {
  TYPESAFE_API_KEY: "test-only-key",
  JEV_INPUT_PRICE: "0.042",
  JEV_OUTPUT_PRICE: "0",
  PLAY_GRANT_USD: "0.10",
  DAILY_CAP_USD: "5",
};
const BYTES = 3500,
  RESERVE = reservationFor(BYTES, 0.042); // (1750 + 2048) × 42 = 159516
const rid = (n) => `request-${String(n).padStart(8, "0")}-x`;
const nano = (usd) => Math.round(usd * 1e9);
// Failure paths log on purpose; keep the test output readable.
console.error = () => {};

class MemoryStorage {
  data = new Map();
  puts = 0;
  async get(key) {
    await null;
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    this.puts++;
    this.data.set(key, structuredClone(value));
    await null;
  }
  async delete(key) {
    this.data.delete(key);
  }
}

const upstream = (status, billable) =>
  Object.assign(new Error(`Jev API returned HTTP ${status}.`), {
    status: [401, 402, 429].includes(status) ? status : 502,
    billable,
  });
const timeout = () =>
  Object.assign(new Error("timed out"), { name: "TimeoutError" });

// A world with a scripted Jev: each call parks until the test releases it.
async function world({
  env = ENV,
  storage = new MemoryStorage(),
  guardStorage = new MemoryStorage(),
} = {}) {
  const clock = { t: Date.UTC(2026, 8, 19, 12) };
  const calls = [];
  const guard = new DailyGuard({
    storage: guardStorage,
    env,
    now: () => clock.t,
  });
  await guard.load();
  const prepare = (body) => {
    if (!body.shared)
      throw Object.assign(new Error("bad"), { status: 400, billable: false });
    const questions = body.only_option ? {} : { h9: {} };
    return {
      prepared: { request: { questions } },
      payload: "{}",
      bytes: body.bytes ?? BYTES,
    };
  };
  const evaluate = (body, _env, _signal, onUsage, prebuilt) =>
    new Promise((resolve, reject) => {
      const call = {
        body,
        prebuilt,
        async finish(tokens, { invalidAnswers = false } = {}) {
          const usage = { input_tokens: tokens, output_tokens: 0 };
          await onUsage(usage);
          if (invalidAnswers)
            return reject(
              Object.assign(new Error("bad answers"), { status: 502 }),
            );
          resolve({
            model: "jev-latest",
            source: tokens ? "jev" : "only_option",
            decisions: { h9: { choice: "shoot" } },
            invalid: [],
            usage,
            request: { big: "prompt" },
          });
        },
        fail: reject,
      };
      calls.push(call);
      if (body.auto !== undefined) call.finish(body.auto);
    });
  const open = async (store = storage) => {
    const ledger = new Ledger({
      storage: store,
      env,
      evaluate,
      prepare,
      guard,
      now: () => clock.t,
    });
    await ledger.load();
    return ledger;
  };
  const ledger = await open();
  await ledger.initialize(IDENTITY);
  const body = (n, extra) => ({
    shared: {},
    decisions: [],
    request_id: rid(n),
    ...extra,
  });
  // Starts a decide and waits until it reached Jev (or returned early).
  const begin = async (n, extra, on = ledger) => {
    clock.t += 150;
    const before = calls.length;
    const promise = on.decide(body(n, extra));
    for (let i = 0; i < 20 && calls.length === before; i++) await null;
    return { promise, call: calls[before] };
  };
  return { ledger, guard, storage, clock, calls, open, body, begin };
}

const balanced = (ledger) => {
  const s = ledger.state;
  let held = 0;
  for (const n of ledger.inflight.values()) held += n;
  const remaining = s.granted + s.purchased - s.spent - held;
  for (const n of [s.granted, s.purchased, s.spent, remaining])
    assert.ok(Number.isSafeInteger(n) && n >= 0, `money ${n}`);
  // `available_usd` is what can be reserved now (holds subtracted); `remaining_usd`
  // is what has not been charged yet, so it never rises when a call settles.
  const credits = ledger.credits();
  assert.equal(Math.round(credits.available_usd * 1e9), remaining);
  assert.equal(Math.round(credits.remaining_usd * 1e9), s.granted + s.purchased - s.spent);
  assert.ok(credits.remaining_usd >= credits.available_usd);
  return remaining;
};

test("price math is exact integer nanodollars", () => {
  assert.equal(tokenCost(1000, 0.042), 42_000);
  assert.equal(tokenCost(1, 0.042), 42);
  assert.equal(tokenCost(1701, 0.042), 71_442);
  assert.equal(tokenCost(0.5, 0.0421), 22); // ceil(21.05)
  assert.equal(RESERVE, 159_516);
  assert.equal(usdToNano("0.10"), 100_000_000);
  assert.equal(usdToNano(undefined, 5), 5e9);
  for (const bad of ["x", -1, 1e300]) assert.throws(() => usdToNano(bad));
});

test("the grant happens once; identity is pinned; profile updates", async () => {
  const w = await world();
  assert.deepEqual(w.ledger.snapshot(), {
    user: IDENTITY,
    credits: {
      granted_usd: 0.1,
      purchased_usd: 0,
      remaining_usd: 0.1,
      available_usd: 0.1,
      spent_usd: 0,
      exhausted: false,
    },
  });
  const again = await w.ledger.initialize({ ...IDENTITY, name: "Ada L." });
  assert.equal(again.user.name, "Ada L.");
  assert.equal(again.credits.granted_usd, 0.1);
  const reopened = await w.open();
  assert.equal((await reopened.initialize(IDENTITY)).credits.granted_usd, 0.1);
  await assert.rejects(w.ledger.initialize({ ...IDENTITY, id: "gh_43" }));
  await assert.rejects(w.ledger.initialize({ ...IDENTITY, id: "gg_42" }));
  await assert.rejects(w.ledger.initialize({ id: "root", provider: "github" }));
  const blank = new Ledger({
    storage: new MemoryStorage(),
    env: {},
    now: () => 0,
  });
  await blank.load();
  assert.equal(blank.snapshot(), null);
  assert.equal((await blank.decide(w.body(1))).status, 401);
  assert.equal((await blank.initialize(IDENTITY)).credits.granted_usd, 0.1); // default
});

test("reserve → settle: the hold is visible in flight, then only usage is charged", async () => {
  const w = await world();
  const { promise, call } = await w.begin(1);
  assert.equal(balanced(w.ledger), nano(0.1) - RESERVE);
  assert.deepEqual(w.storage.data.get("state").pending, { [rid(1)]: RESERVE });
  assert.equal(w.guard.snapshot().reserved, RESERVE);
  assert.equal(call.prebuilt.bytes, BYTES);
  await call.finish(1701);
  const { status, body } = await promise;
  assert.equal(status, 200);
  assert.equal(body.source, "jev");
  assert.deepEqual(body.request, { big: "prompt" });
  assert.equal(body.credits.spent_usd, 71_442 / 1e9);
  assert.equal(balanced(w.ledger), nano(0.1) - 71_442);
  assert.deepEqual(w.storage.data.get("state").pending, {});
  assert.deepEqual(w.guard.snapshot(), {
    day: "2026-09-19",
    reserved: 0,
    spent: 71_442,
  });
});

test("the balance shown to the player never rises when overlapping calls settle", async () => {
  // Two calls overlap, as in a real match. Each response is a snapshot taken
  // while the other call's worst-case hold is still open; counting that hold
  // in `remaining_usd` made the HUD's credit dip and then climb back.
  const w = await world();
  const shown = [w.ledger.credits().remaining_usd];
  const one = await w.begin(1);
  shown.push(w.ledger.credits().remaining_usd);
  w.clock.t += 150;
  const two = await w.begin(2);
  shown.push(w.ledger.credits().remaining_usd);
  assert.equal(w.ledger.credits().available_usd, (nano(0.1) - 2 * RESERVE) / 1e9);
  await one.call.finish(1701);
  shown.push((await one.promise).body.credits.remaining_usd);
  await two.call.finish(1650);
  shown.push((await two.promise).body.credits.remaining_usd);
  shown.push(w.ledger.credits().remaining_usd);
  for (let i = 1; i < shown.length; i++)
    assert.ok(shown[i] <= shown[i - 1], `credit rose: ${shown.join(" → ")}`);
  assert.equal(shown.at(-1), w.ledger.credits().available_usd); // nothing left in flight
  assert.ok(shown.at(-1) < 0.1);
});

test("a single legal option costs nothing and skips the guard", async () => {
  const w = await world();
  const { promise } = await w.begin(1, { only_option: true, auto: 0 });
  const { status, body } = await promise;
  assert.equal(status, 200);
  assert.equal(body.credits.remaining_usd, 0.1);
  assert.equal(w.guard.snapshot().reserved + w.guard.snapshot().spent, 0);
});

test("a repeated request_id returns the receipt and never charges twice", async () => {
  const w = await world();
  const first = await (await w.begin(1, { auto: 1000 })).promise;
  const replay = await w.ledger.decide(w.body(1)); // no spacing needed for a replay
  assert.equal(w.calls.length, 1);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.decisions, first.body.decisions);
  assert.equal(replay.body.request, null); // the prompt echo is not kept
  assert.equal(balanced(w.ledger), nano(0.1) - 42_000);
  // …also across a Durable Object restart
  const reopened = await w.open();
  assert.equal((await reopened.decide(w.body(1))).status, 200);
  assert.equal(w.calls.length, 1);
  // only the last 16 are kept
  for (let n = 2; n <= 18; n++) await (await w.begin(n, { auto: 10 })).promise;
  assert.equal(w.ledger.state.receipts.length, 16);
  assert.equal(w.storage.data.has(`receipt:${rid(1)}`), false);
  assert.equal(w.storage.data.has(`receipt:${rid(18)}`), true);
});

test("bad ids and bad batches are 400 and free", async () => {
  const w = await world();
  for (const request_id of [
    undefined,
    "short",
    "x".repeat(81),
    "has space 0123456789",
    12345678901234567,
  ])
    assert.equal(
      (await w.ledger.decide({ shared: {}, request_id })).status,
      400,
    );
  assert.equal((await w.ledger.decide(null)).status, 400);
  w.clock.t += 150;
  assert.equal((await w.ledger.decide({ request_id: rid(1) })).status, 400);
  w.clock.t += 150;
  assert.equal(
    (await w.ledger.decide(w.body(2, { bytes: 48_001 }))).status,
    413,
  );
  assert.equal(w.calls.length, 0);
  assert.equal(balanced(w.ledger), nano(0.1));
  assert.equal(w.ledger.inflight.size, 0);
});

for (const order of ["first settles first", "second settles first"])
  test(`two in flight, a third is 429, ${order}`, async () => {
    const w = await world();
    const a = await w.begin(1),
      b = await w.begin(2);
    assert.equal(balanced(w.ledger), nano(0.1) - 2 * RESERVE);
    const third = await w.begin(3);
    assert.equal((await third.promise).status, 429);
    assert.equal(third.call, undefined);
    const same = await w.begin(1);
    assert.equal((await same.promise).status, 429);
    const pair = order.startsWith("first") ? [a, b] : [b, a];
    await pair[0].call.finish(1500);
    assert.equal(balanced(w.ledger), nano(0.1) - 63_000 - RESERVE);
    await pair[1].call.finish(2000);
    const results = await Promise.all([a.promise, b.promise]);
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200],
    );
    assert.equal(balanced(w.ledger), nano(0.1) - 63_000 - 84_000);
    assert.deepEqual(w.guard.snapshot(), {
      day: "2026-09-19",
      reserved: 0,
      spent: 147_000,
    });
    assert.deepEqual(w.storage.data.get("state").pending, {});
    assert.equal((await (await w.begin(4, { auto: 1 })).promise).status, 200);
  });

test("starts closer than 100 ms are 429", async () => {
  const w = await world();
  await (
    await w.begin(1, { auto: 10 })
  ).promise;
  w.clock.t += 99;
  assert.equal((await w.ledger.decide(w.body(2, { auto: 10 }))).status, 429);
  w.clock.t += 1;
  assert.equal((await w.ledger.decide(w.body(2, { auto: 10 }))).status, 200);
});

test("402 when the balance cannot cover the reservation", async () => {
  const w = await world({
    env: { ...ENV, PLAY_GRANT_USD: String((RESERVE + 100) / 1e9) },
  });
  assert.equal(w.ledger.credits().exhausted, true); // cannot cover a worst-case batch
  const ok = await (await w.begin(1, { auto: 1000 })).promise;
  assert.equal(ok.status, 200);
  const broke = await (await w.begin(2)).promise;
  assert.equal(broke.status, 402);
  assert.equal(broke.body.code, "credit_exhausted");
  assert.equal(broke.body.credits.exhausted, true);
  assert.equal(w.calls.length, 1);
  assert.equal(balanced(w.ledger), RESERVE + 100 - 42_000);
  // two concurrent requests cannot both spend the same last credit
  const v = await world({
    env: { ...ENV, PLAY_GRANT_USD: String((RESERVE + 100) / 1e9) },
  });
  const a = await v.begin(1);
  assert.equal((await (await v.begin(2)).promise).status, 402);
  await a.call.finish(100);
  assert.equal((await a.promise).status, 200);
});

test("an unbilled upstream 4xx refunds fully and may be retried", async () => {
  const w = await world();
  for (const [status, expected] of [
    [429, 429],
    [401, 502],
    [402, 502],
    [400, 502],
  ]) {
    const { promise, call } = await w.begin(status);
    call.fail(upstream(status, false));
    const result = await promise;
    assert.equal(result.status, expected, `upstream ${status}`);
    assert.ok(!/key|\.env|typesafe/i.test(result.body.error));
    assert.equal(result.body.credits.remaining_usd, 0.1);
  }
  assert.equal(balanced(w.ledger), nano(0.1));
  assert.deepEqual(w.guard.snapshot(), {
    day: "2026-09-19",
    reserved: 0,
    spent: 0,
  });
  assert.deepEqual(w.ledger.state.receipts, []);
  const retry = await w.begin(429, { auto: 500 });
  assert.equal((await retry.promise).status, 200);
});

test("timeouts, 5xx and post-usage failures keep the debit and leave a receipt", async () => {
  const w = await world();
  let n = 0;
  for (const error of [
    timeout(),
    upstream(503, true),
    new TypeError("fetch failed"),
  ]) {
    const { promise, call } = await w.begin(++n);
    call.fail(error);
    const result = await promise;
    assert.equal(result.status, 502);
    assert.equal(balanced(w.ledger), nano(0.1) - n * RESERVE);
    const replay = await w.ledger.decide(w.body(n));
    assert.equal(replay.status, 502);
    assert.equal(balanced(w.ledger), nano(0.1) - n * RESERVE);
  }
  assert.equal(w.calls.length, 3);
  assert.equal(w.guard.snapshot().spent, 3 * RESERVE);
  // usage reported, then the answers turn out invalid: charged the usage only
  const { promise, call } = await w.begin(9);
  await call.finish(1000, { invalidAnswers: true });
  assert.equal((await promise).status, 502);
  assert.equal(balanced(w.ledger), nano(0.1) - 3 * RESERVE - 42_000);
  assert.equal(w.ledger.inflight.size, 0);
});

test("usage above the reservation never overdraws the account", async () => {
  const w = await world({
    env: { ...ENV, PLAY_GRANT_USD: String((RESERVE + 5) / 1e9) },
  });
  const log = console.error;
  console.error = () => {};
  try {
    const { promise, call } = await w.begin(1);
    await call.finish(1_000_000);
    assert.equal((await promise).status, 200);
  } finally {
    console.error = log;
  }
  assert.equal(balanced(w.ledger), 0);
  assert.equal(w.ledger.state.spent, RESERVE + 5);
});

test("a pending reservation found on reload becomes a kept debit", async () => {
  const w = await world();
  await w.begin(1);
  await w.begin(2);
  const reopened = await w.open(); // the old object is gone mid-flight
  assert.equal(balanced(reopened), nano(0.1) - 2 * RESERVE);
  assert.equal(reopened.state.spent, 2 * RESERVE);
  assert.deepEqual(reopened.state.pending, {});
  assert.deepEqual(w.storage.data.get("state").pending, {});
  const replay = await reopened.decide(w.body(1));
  assert.equal(replay.status, 502);
  assert.equal(w.calls.length, 2);
});

test("daily cap → 503 daily_cap, nothing held; the guard rolls over at UTC midnight", async () => {
  const w = await world({
    env: { ...ENV, DAILY_CAP_USD: String((RESERVE * 1.5) / 1e9) },
  });
  const a = await w.begin(1);
  const capped = await (await w.begin(2)).promise;
  assert.equal(capped.status, 503);
  assert.equal(capped.body.code, "daily_cap");
  assert.equal(balanced(w.ledger), nano(0.1) - RESERVE);
  assert.deepEqual(Object.keys(w.storage.data.get("state").pending), [rid(1)]);
  await a.call.finish(1000);
  await a.promise;
  assert.deepEqual(w.guard.snapshot(), {
    day: "2026-09-19",
    reserved: 0,
    spent: 42_000,
  });
  assert.equal((await (await w.begin(3, { auto: 1000 })).promise).status, 200);
  w.clock.t += 24 * 3600 * 1000;
  assert.deepEqual(w.guard.snapshot(), {
    day: "2026-09-20",
    reserved: 0,
    spent: 0,
  });
  // guard edge cases
  const guard = new DailyGuard({
    storage: new MemoryStorage(),
    env: { DAILY_CAP_USD: "nope" },
    now: () => 0,
  });
  await guard.load();
  assert.equal(await guard.reserve(1), false);
  assert.equal(await w.guard.reserve(-1), false);
  assert.equal(await w.guard.reserve(1.5), false);
});

test("misconfiguration spends nothing", async () => {
  const log = console.error;
  console.error = () => {};
  try {
    for (const env of [
      { ...ENV, JEV_OUTPUT_PRICE: "0.1" },
      { ...ENV, JEV_INPUT_PRICE: "free" },
      { ...ENV, TYPESAFE_API_KEY: "" },
    ]) {
      const w = await world({ env });
      assert.equal((await (await w.begin(1)).promise).status, 503);
      assert.equal(w.calls.length, 0);
    }
    const w = await world();
    w.ledger.guard = {
      reserve: () => Promise.reject(new Error("down")),
      settle: async () => {},
    };
    assert.equal((await (await w.begin(1)).promise).status, 503);
    assert.equal(balanced(w.ledger), nano(0.1));
  } finally {
    console.error = log;
  }
});

test("topUp is idempotent by order_id and tracked as purchased", async () => {
  const w = await world();
  const order = {
    amount_nanodollars: nano(1),
    order_id: "order-1",
    source: "manual",
  };
  assert.equal((await w.ledger.topUp(order)).applied, true);
  const again = await w.ledger.topUp(order);
  assert.equal(again.applied, false);
  assert.deepEqual(again.credits, {
    granted_usd: 0.1,
    purchased_usd: 1,
    remaining_usd: 1.1,
    available_usd: 1.1,
    spent_usd: 0,
    exhausted: false,
  });
  assert.equal((await (await w.open()).topUp(order)).applied, false);
  for (const bad of [
    { ...order, order_id: "o2", amount_nanodollars: 0 },
    { ...order, order_id: "o2", amount_nanodollars: 1.5 },
    { ...order, order_id: "o2", amount_nanodollars: 2 ** 60 },
    { ...order, order_id: "" },
    { ...order, order_id: "has space" },
    undefined,
  ])
    await assert.rejects(w.ledger.topUp(bad));
  const blank = new Ledger({ storage: new MemoryStorage(), env: ENV });
  await blank.load();
  await assert.rejects(blank.topUp(order));
});

test("reverseTopUp removes at most the unspent balance, once", async () => {
  const w = await world({ env: { ...ENV, PLAY_GRANT_USD: "0" } });
  await w.ledger.topUp({ amount_nanodollars: 1_000_000, order_id: "o1" });
  await w.ledger.topUp({ amount_nanodollars: 1_000_000, order_id: "o2" });
  const full = await w.ledger.reverseTopUp({
    order_id: "o1",
    amount_nanodollars: 1_000_000,
  });
  assert.equal(full.removed_nanodollars, 1_000_000);
  assert.equal(full.shortfall_nanodollars, 0);
  assert.equal(full.credits.purchased_usd, 0.001);
  await (
    await w.begin(1, { auto: 10_000 })
  ).promise; // spends 420 000
  const partial = await w.ledger.reverseTopUp({
    order_id: "o2",
    amount_nanodollars: 1_000_000,
  });
  assert.equal(partial.removed_nanodollars, 580_000);
  assert.equal(partial.shortfall_nanodollars, 420_000);
  assert.equal(w.ledger.state.refund_shortfall, 420_000);
  assert.equal(balanced(w.ledger), 0);
  const replay = await w.ledger.reverseTopUp({
    order_id: "o2",
    amount_nanodollars: 1_000_000,
  });
  assert.equal(replay.removed_nanodollars, 580_000);
  assert.equal(w.ledger.state.refund_shortfall, 420_000);
  await assert.rejects(
    w.ledger.reverseTopUp({ order_id: "nope", amount_nanodollars: 1 }),
  );
  await assert.rejects(
    w.ledger.reverseTopUp({ order_id: "constructor", amount_nanodollars: 1 }),
  );
  await w.ledger.topUp({ amount_nanodollars: 10, order_id: "o3" });
  for (const amount_nanodollars of [0, -1, 1.5, 11, "5"])
    await assert.rejects(
      w.ledger.reverseTopUp({ order_id: "o3", amount_nanodollars }),
    );
});

test("randomized play never drives the balance negative or loses a nanodollar", async () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const log = console.error;
  console.error = () => {};
  try {
    const w = await world({
      env: { ...ENV, PLAY_GRANT_USD: "0.002", DAILY_CAP_USD: "0.004" },
    });
    let ledger = w.ledger,
      open = [],
      n = 0,
      statuses = new Set();
    const finishOne = async () => {
      const [{ promise, call }] = open.splice(
        Math.floor(random() * open.length),
        1,
      );
      const roll = random();
      if (roll < 0.6) await call.finish(Math.floor(random() * 6000));
      else if (roll < 0.75) call.fail(upstream(429, false));
      else if (roll < 0.9) call.fail(timeout());
      else call.fail(upstream(500, true));
      statuses.add((await promise).status);
    };
    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.55) {
        const started = await w.begin(
          ++n,
          { bytes: 500 + Math.floor(random() * 40_000) },
          ledger,
        );
        if (started.call) open.push(started);
        else statuses.add((await started.promise).status);
      } else if (roll < 0.85 && open.length) await finishOne();
      else if (roll < 0.9)
        await ledger.topUp({
          amount_nanodollars: 1 + Math.floor(random() * 400_000),
          order_id: `o${step % 7}`,
        });
      else if (roll < 0.93 && n)
        statuses.add(
          (
            await ledger.decide(
              w.body(1 + Math.floor(random() * n), { auto: 100 }),
            )
          ).status,
        );
      else if (roll < 0.95) {
        open = []; // crash: in-flight calls are abandoned
        ledger = await w.open();
      } else if (roll < 0.97) w.clock.t += 24 * 3600 * 1000;
      balanced(ledger);
      const day = w.guard.snapshot();
      assert.ok(day.reserved >= 0 && day.spent >= 0);
      assert.ok(ledger.inflight.size <= 2);
    }
    while (open.length) await finishOne();
    assert.equal(ledger.inflight.size, 0);
    assert.deepEqual(ledger.state.pending, {});
    const s = ledger.state;
    assert.equal(balanced(ledger), s.granted + s.purchased - s.spent);
    for (const expected of [200, 402, 429, 502])
      assert.ok(statuses.has(expected), `saw ${expected}`);
  } finally {
    console.error = log;
  }
});
