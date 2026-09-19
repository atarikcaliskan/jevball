const clock = () => globalThis.performance?.now() ?? Date.now();

// ---- cost controls -------------------------------------------------------
// Jev bills input tokens. Measured live, a call costs ~1,000 tokens before its
// first question (API overhead, legend, players, playbook) and ~200 per
// off-ball question (~430 for the carrier), so both fewer questions and fuller
// calls pay. Jev's attention goes where the football is decided: the carrier,
// restarts, keepers and everyone near the ball are always asked.
export const TRIAGE = {
  // Beyond this an off-ball player cannot reach the play before his next
  // decision (1.2 s at <= 8 m/s): ask Jev only if the local policy is torn
  // between options that are more than positioning (press, mark, run, chase).
  farM: 28,
  // Out here whatever he picks is a jog that is re-decided long before the
  // ball arrives, so the local policy always decides.
  deepM: 42,
  // Local top probability that counts as "already sure".
  confident: 0.8,
  // Prefer one fuller call over two thin ones: a batch without the carrier or
  // restart taker waits until it has this many questions ...
  minBatch: 4,
  // ... or until its oldest player has waited this long (two 250 ms ticks).
  holdMs: 500,
  // A free ball is a race: whoever is this close to it is never held back.
  urgentM: 8,
  // Off-ball players further than this from the ball keep Jev's last choice
  // (with freshly computed targets) instead of re-asking, for at most keepS
  // sim-seconds and only while nothing changed: same kind, same option set and
  // the local policy reads the situation as it did when Jev was asked. Inside
  // nearM every decision is a fresh Jev call.
  nearM: 15,
  keepS: 2.5,
  // ... and only a choice Jev gave at least even odds. Audited live
  // (AUDIT_KEEP=1 npm run test:jev re-asks anyway): Jev repeated a standing
  // choice held at >= 0.5 in 85 % of cases (>= 0.6: 95-100 %), one held below
  // 0.5 in 72 %; identical requests repeat ~93 % of the time.
  keepConfidence: 0.5,
};
const POSITIONAL = new Set(["shape", "cover", "support"]);
const OFF_BALL = new Set(["attack", "defend", "loose"]);

const ballDistance = (sim, p) =>
  sim.ball && Number.isFinite(p.x)
    ? Math.hypot(p.x - sim.ball.x, p.y - sim.ball.y)
    : 0;

// True when this decision is low-stakes enough for the local policy.
export function triage(state, ballDistanceM, rules = TRIAGE) {
  if (!OFF_BALL.has(state?.kind) || state.self?.has_ball) return false;
  if (!(ballDistanceM > rules.farM)) return false;
  if (ballDistanceM > rules.deepM) return true;
  const options = Object.values(state.options);
  return (
    options.every((o) => POSITIONAL.has(o.action)) ||
    Math.max(...Object.values(state.local?.probabilities ?? {}), 0) >=
      rules.confident
  );
}

const sameKeys = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b);
};

// Jev's previous answer still stands: returns it, or null to ask again.
export function keepable(sim, player, state, ballDistanceM, rules = TRIAGE) {
  const d = player.decision,
    asked = d?.jev; // set by applyJev: { at, local } when Jev last answered
  if (!asked || !OFF_BALL.has(state?.kind) || state.self?.has_ball) return null;
  if (!(ballDistanceM > rules.nearM) || !(sim.time - asked.at <= rules.keepS))
    return null;
  if (
    d.kind !== state.kind ||
    !((d.probabilities?.[d.choice] ?? 0) >= rules.keepConfidence) ||
    asked.local !== state.local?.choice ||
    !sameKeys(d.probabilities ?? {}, state.options)
  )
    return null;
  return d;
}

// Applies a Jev answer and remembers when and under which local reading it was
// given, so keepable() can tell later whether anything changed.
export function applyJev(sim, player, state, answer, latencyMs) {
  const rule = answer.source === "only_option";
  const ok =
    sim.applyDecision(player.id, answer.batch_id, answer.choice, {
      // only_option was never Jev's call; the contract names it a rule.
      source: rule ? "rule" : "jev",
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      latencyMs,
    }) !== false;
  if (ok && !rule && player.decision)
    player.decision.jev = { at: sim.time, local: state?.local?.choice ?? null };
  return ok;
}

// Re-applies Jev's standing choice to the fresh state (new target geometry).
export function applyKept(sim, { player, state, previous }) {
  const ok =
    sim.applyDecision(player.id, state.batch_id, previous.choice, {
      source: "jev",
      probabilities: previous.probabilities,
      confidence: previous.confidence,
      latencyMs: 0,
    }) !== false;
  if (ok && player.decision) player.decision.jev = previous.jev;
  return ok;
}

// One scheduling step, shared by the browser loop and scripts/verify-jev.mjs
// so the live measurement bills exactly what the browser would.
//   due      sim.decisionDue(): most urgent first
//   waiting  Map(player id -> ms when first due but not sent), from the last plan
// Returns who is sent to Jev now ({player, state}), who decides locally
// (single option / starved), who was triaged, who keeps Jev's standing choice
// ({player, state, previous}), and the new waiting map.
export function planBatch(
  sim,
  due,
  {
    now = 0,
    waiting = new Map(),
    canSend = true,
    maxBatch = 12,
    maxWaitMs = 900,
    rules = TRIAGE,
  } = {},
) {
  const plan = {
    send: [],
    local: [],
    triaged: [],
    kept: [],
    waiting: new Map(),
  };
  const urgentIds = [sim.ball?.ownerId, sim.restart?.takerId];
  const candidates = [];
  for (const p of due) {
    // Cheap distance gate first: states are only built early for players
    // who may be resolved without Jev.
    const d = ballDistance(sim, p);
    if (urgentIds.includes(p.id) || !(d > Math.min(rules.nearM, rules.farM))) {
      candidates.push({ player: p });
      continue;
    }
    const state = sim.decisionState(p);
    if (!state?.options || Object.keys(state.options).length < 2) {
      plan.local.push(p);
      continue;
    }
    const previous = keepable(sim, p, state, d, rules);
    if (triage(state, d, rules)) plan.triaged.push(p);
    else if (previous) plan.kept.push({ player: p, state, previous });
    else candidates.push({ player: p, state });
  }
  const since = (p) => waiting.get(p.id) ?? now;
  const batch = canSend ? candidates.slice(0, maxBatch) : [];
  const go =
    batch.some(
      (c) =>
        urgentIds.includes(c.player.id) ||
        (sim.ball &&
          !sim.ball.ownerId &&
          !sim.ball.flight?.toId && // a pass on its way is not a loose ball
          ballDistance(sim, c.player) <= rules.urgentM),
    ) ||
    batch.length >= Math.min(rules.minBatch, maxBatch) ||
    batch.some((c) => now - since(c.player) >= rules.holdMs);
  for (const c of go ? batch : []) {
    // A single legal option needs no model (and no round trip).
    c.state ??= sim.decisionState(c.player);
    if (!c.state?.options || Object.keys(c.state.options).length < 2)
      plan.local.push(c.player);
    else plan.send.push(c);
  }
  // The sim's late-decision fallback only covers pending players, so anyone
  // squeezed out of batches for too long decides locally here.
  for (const { player } of go ? candidates.slice(batch.length) : candidates) {
    if (now - since(player) >= maxWaitMs) plan.local.push(player);
    else plan.waiting.set(player.id, since(player));
  }
  return plan;
}

// Arrow polylines and the local verdict are never used server-side; leaving
// them out keeps each POST a few kB instead of tens.
const slim = ({ local, options, ...decision }) => ({
  ...decision,
  options: Object.fromEntries(
    Object.entries(options).map(([id, { path, ...option }]) => [id, option]),
  ),
});

export class DecisionLoop {
  constructor(
    sim,
    {
      fetch = (...args) => globalThis.fetch(...args),
      endpoint = "/api/decide",
      maxBatch = 12, // same as the server's limit
      maxInFlight = 2,
      tickMs = 250,
      maxWaitMs = 900,
      rules = TRIAGE,
    } = {},
  ) {
    Object.assign(this, {
      sim,
      fetch,
      endpoint,
      maxBatch,
      maxInFlight,
      tickMs,
      maxWaitMs,
      rules,
    });
    this.configured = false;
    this.enabled = true;
    this.inFlight = 0;
    this.failures = 0;
    this.backoffUntil = 0;
    this.now = 0;
    this.lastTick = -Infinity;
    this.waiting = new Map(); // player id -> first tick it was due but not sent
    this.requests = new Set();
    this.tally = {
      calls: 0,
      decisions: 0,
      jevDecisions: 0,
      localDecisions: 0,
      triaged: 0, // subset of localDecisions: low-stakes, never offered to Jev
      kept: 0, // Jev's standing choice re-applied without a new question
      held: 0, // subset of localDecisions: made while sign-in/credit was missing
      stale: 0,
      cost: 0,
      input: 0,
      output: 0,
      request_bytes: 0,
      latencies: [],
      errors: 0,
    };
    this.last = null;
    this.lastError = null;
    // Hosted mode (docs/AUTH.md): "auth" | "credit" | "cap" while the server
    // refuses to spend for this user. Everyone decides locally and nothing is
    // requested until the UI calls resume() (after sign-in, top-up, re-check).
    this.held = null;
    this.credits = null; // latest `credits` object the server reported
    this.onBatch = () => {};
    this.onError = () => {};
    this.onAuthRequired = () => {};
    this.onCreditExhausted = () => {};
    this.onCredits = () => {};
  }

  resume() {
    this.held = null;
    this.failures = 0;
    this.backoffUntil = 0;
  }

  get backingOff() {
    return this.now < this.backoffUntil;
  }

  // Resolves when every request currently in flight has been applied.
  idle() {
    return Promise.all(this.requests);
  }

  async checkStatus(url = "/api/status") {
    try {
      const res = await this.fetch(url);
      const status = res.ok ? await res.json() : null;
      this.configured = !!status?.configured;
      return status;
    } catch {
      this.configured = false;
      return null;
    }
  }

  tick(nowMs = clock()) {
    try {
      this.now = nowMs;
      if (nowMs - this.lastTick < this.tickMs || this.sim.paused) return;
      this.lastTick = nowMs;
      const due = this.sim.decisionDue();
      if (!due.length) return this.waiting.clear();
      if (!this.configured || !this.enabled || this.backingOff || this.held) {
        this.waiting.clear();
        for (const p of due) this.#local(p);
        if (this.held && this.configured && this.enabled)
          this.tally.held += due.length;
        return;
      }
      const plan = planBatch(this.sim, due, {
        now: nowMs,
        waiting: this.waiting,
        canSend: this.inFlight < this.maxInFlight,
        maxBatch: this.maxBatch,
        maxWaitMs: this.maxWaitMs,
        rules: this.rules,
      });
      this.waiting = plan.waiting;
      for (const p of plan.local) this.#local(p);
      for (const p of plan.triaged) {
        this.#local(p);
        this.tally.triaged++;
      }
      for (const k of plan.kept) {
        if (applyKept(this.sim, k)) {
          this.tally.decisions++;
          this.tally.kept++;
        } else this.#local(k.player);
      }
      if (!plan.send.length) return;
      for (const { player } of plan.send) player.pending = true;
      const request = this.#send(plan.send).finally(() =>
        this.requests.delete(request),
      );
      this.requests.add(request);
    } catch (e) {
      this.#report(e?.message || "Decision loop failed.");
    }
  }

  #local(player) {
    try {
      player.pending = false;
      this.sim.decideLocally(player);
      this.tally.decisions++;
      this.tally.localDecisions++;
    } catch (e) {
      this.#report(e?.message || "Local decision failed.");
    }
  }

  #call(name, ...args) {
    try {
      this[name](...args);
    } catch {}
  }

  #credits(credits) {
    if (!credits || typeof credits !== "object") return;
    const changed = JSON.stringify(credits) !== JSON.stringify(this.credits);
    this.credits = credits;
    if (changed) this.#call("onCredits", credits);
  }

  #report(message) {
    this.lastError = message;
    try {
      this.onError(message);
    } catch {}
  }

  async #send(sent) {
    const players = sent.map((s) => s.player),
      decisions = sent.map((s) => slim(s.state));
    const started = clock();
    this.inFlight++;
    this.tally.calls++;
    let data = null,
      failure = null;
    try {
      const res = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shared: this.sim.sharedState(),
          decisions,
          // Idempotency key for the hosted ledger. A batch is never retried
          // (its players fall back to the local policy), so one id per POST.
          request_id: globalThis.crypto.randomUUID(),
        }),
      });
      const body = await res.json().catch(() => null);
      this.#credits(body?.credits);
      if (!res.ok)
        failure = {
          status: res.status,
          message: body?.error || `Jev request failed with HTTP ${res.status}.`,
          hold:
            res.status === 401 && body?.auth_required
              ? "auth"
              : res.status === 402 && body?.code === "credit_exhausted"
                ? "credit"
                : res.status === 503 && body?.code === "daily_cap"
                  ? "cap"
                  : null,
        };
      else if (!body?.decisions || typeof body.decisions !== "object")
        failure = {
          status: 502,
          message: "Jev returned an unreadable response.",
        };
      else data = body;
    } catch (e) {
      failure = {
        status: 0,
        message: `Jev is unreachable: ${e?.message || e}`,
      };
    }
    this.inFlight--;
    const latencyMs = Math.round(clock() - started);
    let applied = 0,
      stale = 0,
      missing = 0;
    for (const { player: p, state } of sent) {
      p.pending = false;
      const answer = data?.decisions[p.id];
      let ok = false;
      try {
        ok = !!answer && applyJev(this.sim, p, state, answer, latencyMs);
      } catch {}
      if (ok) {
        applied++;
        this.tally.decisions++;
        this.tally.jevDecisions++;
      } else {
        if (answer) stale++;
        else if (data) missing++;
        // Skip only when the sim's own late fallback already decided for him.
        if (!(p.nextDecisionAt > this.sim.time)) this.#local(p);
      }
    }
    this.tally.stale += stale;
    if (failure) {
      this.tally.errors++;
      if (failure.hold) {
        // The server will not spend for this user right now: no retries, no
        // backoff spiral. The callback fires once per hold, even when two
        // requests in flight are refused together.
        const first = !this.held;
        this.held ??= failure.hold;
        if (first && failure.hold === "auth") this.#call("onAuthRequired");
        if (first && failure.hold === "credit")
          this.#call("onCreditExhausted", this.credits);
        if (first) this.#report(failure.message);
        return;
      }
      // Missing or rejected key: stop asking until the UI re-checks status.
      if ([401, 503].includes(failure.status)) this.configured = false;
      // Everything else (429, 5xx, credit, network) retries 1 s, 2 s, 4 s ... 15 s.
      else
        this.backoffUntil =
          this.now + Math.min(15000, 1000 * 2 ** this.failures++);
      this.#report(failure.message);
      return;
    }
    this.failures = 0;
    this.backoffUntil = 0;
    this.lastError = null;
    const t = this.tally;
    t.cost += data.cost_usd || 0;
    t.input += data.usage?.input_tokens || 0;
    t.output += data.usage?.output_tokens || 0;
    t.request_bytes += data.request_bytes || 0;
    t.latencies.push(data.latency_ms ?? latencyMs);
    if (t.latencies.length > 240) t.latencies.shift();
    this.last = { request: data.request ?? null, response: data, at: this.now };
    try {
      this.onBatch({
        players: players.map((p) => p.id),
        applied,
        stale,
        missing,
        latencyMs,
        cost: data.cost_usd || 0,
        usage: data.usage,
        response: data,
      });
    } catch {}
  }
}
