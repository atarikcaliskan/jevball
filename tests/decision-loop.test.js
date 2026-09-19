import test from "node:test";
import assert from "node:assert/strict";
import {
  DecisionLoop,
  TRIAGE,
  triage,
  planBatch,
  keepable,
  applyJev,
} from "../src/decision-loop.js";
import { validBatch } from "../server/jev.js";
import { FakeSim, defenderDecision } from "./fixtures/decisions.js";

// Server stand-in: answers every decision with its first option.
function decideResponse(body, overrides = {}) {
  return {
    model: "jev-latest",
    source: "jev",
    decisions: Object.fromEntries(
      body.decisions.map((d) => {
        const ids = Object.keys(d.options);
        return [
          d.player_id,
          {
            batch_id: d.batch_id,
            choice: ids[0],
            probabilities: Object.fromEntries(
              ids.map((id, i) => [id, i ? 0.2 : 0.8]),
            ),
            confidence: 0.8,
            source: "jev",
          },
        ];
      }),
    ),
    usage: { input_tokens: 1500, output_tokens: 40 },
    latency_ms: 120,
    request_bytes: 4000,
    cost_usd: 0.000063,
    pricing: { input_per_million: 0.042, output_per_million: 0 },
    request: { model: "jev-latest", state: {}, questions: {} },
    ...overrides,
  };
}

function setup(respond, options) {
  const sim = new FakeSim(options?.ids);
  const posts = [];
  const fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    posts.push({ url, body });
    return respond(body, posts.length);
  };
  const loop = new DecisionLoop(sim, { fetch, ...options });
  loop.configured = true;
  const errors = [];
  loop.onError = (message) => errors.push(message);
  return { sim, loop, posts, errors };
}

test("unconfigured or disabled loops decide locally and never fetch", async () => {
  const { sim, loop, posts } = setup(() => assert.fail("no fetch expected"));
  loop.configured = false;
  loop.tick(0);
  assert.deepEqual(sim.log.local, ["h9", "a6", "h8"]);
  loop.configured = true;
  loop.enabled = false;
  loop.tick(250);
  assert.equal(sim.log.local.length, 6);
  assert.equal(posts.length, 0);
  assert.deepEqual(
    [
      loop.tally.calls,
      loop.tally.decisions,
      loop.tally.localDecisions,
      loop.tally.jevDecisions,
    ],
    [0, 6, 6, 0],
  );
});

test("due players are batched into one valid POST and applied as Jev decisions", async () => {
  const { sim, loop, posts } = setup((body) =>
    Response.json(decideResponse(body)),
  );
  const batches = [];
  loop.onBatch = (info) => batches.push(info);
  loop.tick(1000);
  assert(sim.players.every((p) => p.pending));
  loop.tick(1100); // rate limited: inside tickMs
  await loop.idle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/decide");
  assert(validBatch(posts[0].body));
  assert.deepEqual(
    posts[0].body.decisions.map((d) => d.player_id),
    ["h9", "a6", "h8"],
  );
  // Upload stays small: no polylines, no local verdict.
  assert(!JSON.stringify(posts[0].body).includes('"path"'));
  assert(!JSON.stringify(posts[0].body).includes('"local"'));
  assert(sim.players.every((p) => !p.pending));
  assert.deepEqual(
    sim.log.applied.map((a) => a.id),
    ["h9", "a6", "h8"],
  );
  const { meta } = sim.log.applied[0];
  assert.equal(meta.source, "jev");
  assert.equal(meta.confidence, 0.8);
  assert.equal(meta.probabilities.shoot, 0.8);
  assert(Number.isFinite(meta.latencyMs));
  assert.deepEqual(sim.log.local, []);
  const t = loop.tally;
  assert.deepEqual(
    [t.calls, t.decisions, t.jevDecisions, t.localDecisions, t.stale, t.errors],
    [1, 3, 3, 0, 0, 0],
  );
  assert.deepEqual(
    [t.cost, t.input, t.output, t.request_bytes, t.latencies],
    [0.000063, 1500, 40, 4000, [120]],
  );
  assert.equal(loop.last.response.model, "jev-latest");
  assert.deepEqual(loop.last.request, {
    model: "jev-latest",
    state: {},
    questions: {},
  });
  assert.equal(loop.last.at, 1100);
  assert.deepEqual(
    [batches[0].applied, batches[0].stale, batches[0].missing],
    [3, 0, 0],
  );
});

test("stale or missing answers fall back to the local policy", async () => {
  const { sim, loop } = setup((body) => {
    const data = decideResponse(body);
    delete data.decisions.a6;
    data.decisions.h8.batch_id = "b0";
    return Response.json(data);
  });
  loop.tick(0);
  await loop.idle();
  assert.deepEqual(
    sim.log.applied.map((a) => a.id),
    ["h9"],
  );
  assert.deepEqual(
    sim.log.rejected.map((a) => a.id),
    ["h8"],
  );
  assert.deepEqual(sim.log.local, ["a6", "h8"]);
  assert.deepEqual(
    [
      loop.tally.jevDecisions,
      loop.tally.localDecisions,
      loop.tally.stale,
      loop.tally.errors,
    ],
    [1, 2, 1, 0],
  );
  assert(sim.players.every((p) => !p.pending));

  // The sim's own late fallback already handled this player: don't decide twice.
  const late = setup((body) => Response.json(decideResponse(body)), {
    ids: ["h9"],
  });
  late.sim.rejectAll = true;
  late.sim.players[0].nextDecisionAt = 5;
  late.loop.tick(0);
  await late.loop.idle();
  assert.deepEqual(late.sim.log.local, []);
  assert.equal(late.loop.tally.stale, 1);
});

test("single-option players skip the round trip", async () => {
  const { sim, loop, posts } = setup((body) =>
    Response.json(decideResponse(body)),
  );
  sim.singleOption.add("a6");
  loop.tick(0);
  await loop.idle();
  assert.deepEqual(
    posts[0].body.decisions.map((d) => d.player_id),
    ["h9", "h8"],
  );
  assert.deepEqual(sim.log.local, ["a6"]);
  sim.singleOption = new Set(["h9", "a6", "h8"]);
  loop.tick(250);
  await loop.idle();
  assert.equal(posts.length, 1);
});

test("maxBatch and maxInFlight bound the traffic; starved players decide locally", async () => {
  const release = [];
  const ids = ["h2", "h3", "h4", "h5", "h6", "a2", "a3"];
  const { sim, loop, posts } = setup(
    (body) =>
      new Promise((resolve) =>
        release.push(() => resolve(Response.json(decideResponse(body)))),
      ),
    { ids, maxBatch: 2, maxInFlight: 2, tickMs: 250, maxWaitMs: 900 },
  );
  loop.tick(0);
  loop.tick(250);
  loop.tick(500); // both slots busy: nobody else is sent
  loop.tick(750);
  assert.equal(posts.length, 2);
  assert.equal(loop.inFlight, 2);
  assert.deepEqual(
    posts.map((p) => p.body.decisions.map((d) => d.player_id)),
    [
      ["h2", "h3"],
      ["h4", "h5"],
    ],
  );
  assert.deepEqual(sim.log.local, []);
  loop.tick(1000); // h6, a2, a3 have waited since t=0 → local rather than stalling
  assert.deepEqual(sim.log.local, ["h6", "a2", "a3"]);
  release.forEach((go) => go());
  await loop.idle();
  assert.equal(loop.inFlight, 0);
  assert.equal(loop.tally.jevDecisions, 4);
  loop.tick(1250);
  assert.equal(posts.length, 3);
  release.at(-1)();
  await loop.idle();
});

test("429/5xx/network errors back off exponentially with local play, and reset on success", async () => {
  let mode = "limit";
  const { sim, loop, posts, errors } = setup((body) => {
    if (mode === "limit")
      return Response.json(
        { error: "Jev rate limit reached. Pausing before retry." },
        { status: 429 },
      );
    if (mode === "down")
      return new Response("<html>bad gateway</html>", { status: 502 });
    if (mode === "network") throw new TypeError("fetch failed");
    return Response.json(decideResponse(body));
  });
  const attempt = async (now) => {
    loop.tick(now);
    await loop.idle();
  };
  await attempt(0);
  assert.equal(posts.length, 1);
  assert.deepEqual(sim.log.local, ["h9", "a6", "h8"]); // the failed batch itself
  assert.equal(loop.backoffUntil, 1000);
  assert.match(errors[0], /rate limit/);
  await attempt(500); // inside backoff → local, no request
  assert.equal(posts.length, 1);
  assert.equal(sim.log.local.length, 6);
  mode = "down";
  await attempt(1000);
  assert.equal(posts.length, 2);
  assert.equal(loop.backoffUntil, 3000);
  assert.match(errors[1], /HTTP 502/);
  mode = "network";
  await attempt(3000);
  assert.equal(loop.backoffUntil, 7000);
  assert.match(errors[2], /unreachable/);
  for (const now of [7000, 15000, 31000]) await attempt(now);
  assert.equal(loop.backoffUntil, 31000 + 15000); // capped at 15 s
  assert.equal(loop.tally.errors, 6);
  assert.equal(loop.configured, true);
  mode = "ok";
  await attempt(46000);
  assert.equal(loop.failures, 0);
  assert.equal(loop.backoffUntil, 0);
  assert.equal(loop.tally.jevDecisions, 3);
  mode = "limit";
  await attempt(46250);
  assert.equal(loop.backoffUntil, 47250); // back to 1 s after a success
  assert(sim.players.every((p) => !p.pending));
});

test("401/503 switch to free play; credit errors surface their message", async () => {
  for (const status of [401, 503]) {
    const { sim, loop, posts, errors } = setup(() =>
      Response.json(
        { error: "Jev rejected the API key. Update TYPESAFE_API_KEY in .env." },
        { status },
      ),
    );
    loop.tick(0);
    await loop.idle();
    assert.equal(loop.configured, false);
    assert.match(errors[0], /TYPESAFE_API_KEY/);
    loop.tick(250);
    await loop.idle();
    assert.equal(posts.length, 1);
    assert.equal(sim.log.local.length, 6);
  }
  const credit = setup(() =>
    Response.json({ error: "Jev account is out of credit." }, { status: 402 }),
  );
  credit.loop.tick(0);
  await credit.loop.idle();
  assert.deepEqual(credit.errors, ["Jev account is out of credit."]);
  assert.equal(credit.loop.configured, true);
  assert.deepEqual(credit.sim.log.local, ["h9", "a6", "h8"]);
});

test("tick never throws, even when the sim or callbacks do", async () => {
  const { sim, loop, errors } = setup((body) =>
    Response.json(decideResponse(body)),
  );
  loop.onBatch = () => {
    throw new Error("ui bug");
  };
  loop.tick(0);
  await loop.idle();
  assert.equal(loop.tally.jevDecisions, 3);
  sim.decisionDue = () => {
    throw new Error("sim bug");
  };
  assert.doesNotThrow(() => loop.tick(250));
  assert.deepEqual(errors, ["sim bug"]);
  const status = setup(() =>
    Response.json({ configured: true, model: "jev-latest" }),
  );
  status.loop.configured = false;
  await status.loop.checkStatus();
  assert.equal(status.loop.configured, true);
});

// ---- cost controls: triage, fuller batches, standing choices ----------------
const place = (sim, id, metresFromBall) => {
  const p = sim.players.find((x) => x.id === id);
  p.x = sim.ball.x - metresFromBall;
  p.y = sim.ball.y;
  return p;
};

test("triage: only far, low-stakes off-ball decisions go to the local policy", () => {
  const defend = defenderDecision(); // press / mark / cover / shape, local top 0.7
  const positional = {
    ...defend,
    options: { cover: defend.options.cover, shape: defend.options.shape },
  };
  const sure = {
    ...defend,
    local: { choice: "press", probabilities: { press: 0.85, shape: 0.15 } },
  };
  const between = (TRIAGE.farM + TRIAGE.deepM) / 2;
  assert.equal(triage(defend, TRIAGE.farM - 1), false);
  assert.equal(triage(positional, TRIAGE.farM - 1), false); // near the ball: always Jev
  assert.equal(triage(defend, between), false); // torn between press and mark: Jev
  assert.equal(triage(positional, between), true);
  assert.equal(triage(sure, between), true);
  assert.equal(triage(defend, TRIAGE.deepM + 1), true);
  for (const kind of ["carrier", "restart", "keeper"])
    assert.equal(triage({ ...positional, kind }, 200), false);
  assert.equal(
    triage(
      { ...positional, self: { ...positional.self, has_ball: true } },
      200,
    ),
    false,
  );
});

test("planBatch: thin batches wait for company unless the ball is involved", () => {
  const sim = new FakeSim(["a6", "a7", "h8", "h7", "h6"]);
  sim.ball.ownerId = "h1"; // someone who is not due
  const two = sim.players.slice(0, 2);
  let plan = planBatch(sim, two, { now: 0 });
  assert.deepEqual(plan.send, []);
  assert.deepEqual(
    [...plan.waiting],
    [
      ["a6", 0],
      ["a7", 0],
    ],
  );
  plan = planBatch(sim, two, { now: 250, waiting: plan.waiting });
  assert.deepEqual(plan.send, []);
  // ... but never longer than holdMs
  plan = planBatch(sim, two, { now: TRIAGE.holdMs, waiting: plan.waiting });
  assert.deepEqual(
    plan.send.map((c) => c.player.id),
    ["a6", "a7"],
  );
  assert.equal(plan.send[0].state.player_id, "a6");
  assert.equal(plan.waiting.size, 0);
  // enough questions to fill a call: go now
  plan = planBatch(sim, sim.players.slice(0, TRIAGE.minBatch), { now: 0 });
  assert.equal(plan.send.length, TRIAGE.minBatch);
  // the carrier never waits, and takes whoever is due along
  sim.ball.ownerId = "a7";
  plan = planBatch(sim, two, { now: 0 });
  assert.deepEqual(
    plan.send.map((c) => c.player.id),
    ["a6", "a7"],
  );
  // nor does the restart taker
  sim.ball.ownerId = "h1";
  sim.restart = { takerId: "a6" };
  assert.equal(planBatch(sim, two, { now: 0 }).send.length, 2);
  sim.restart = null;
  sim.ball.ownerId = null;
  // a free ball is a race for whoever is close; a pass on its way is not
  place(sim, "a6", TRIAGE.urgentM - 1);
  place(sim, "a7", TRIAGE.urgentM + 5);
  assert.equal(planBatch(sim, two, { now: 0 }).send.length, 2);
  sim.ball.flight = { toId: "h8" };
  assert.equal(planBatch(sim, two, { now: 0 }).send.length, 0);
  // no free request slot: nobody is sent, starved players go local
  plan = planBatch(sim, sim.players, { now: 0, canSend: false });
  assert.deepEqual(plan.send, []);
  assert.equal(plan.waiting.size, 5);
  plan = planBatch(sim, sim.players, {
    now: 900,
    canSend: false,
    waiting: plan.waiting,
  });
  assert.equal(plan.local.length, 5);
});

test("planBatch: far players are triaged, single options stay local", () => {
  const sim = new FakeSim(["h9", "a6", "a7", "a8"]);
  place(sim, "a6", 5);
  place(sim, "a7", TRIAGE.deepM + 5);
  place(sim, "a8", TRIAGE.deepM + 5);
  sim.singleOption.add("a8");
  const plan = planBatch(sim, sim.players, { now: 0 });
  assert.deepEqual(
    plan.send.map((c) => c.player.id),
    ["h9", "a6"],
  );
  assert.deepEqual(
    plan.triaged.map((p) => p.id),
    ["a7"],
  );
  assert.deepEqual(
    plan.local.map((p) => p.id),
    ["a8"],
  );
  // the carrier is never triaged, wherever the ball model says he is
  place(sim, "h9", TRIAGE.deepM + 5);
  assert.equal(planBatch(sim, sim.players, { now: 0 }).send[0].player.id, "h9");
});

test("Jev's standing choice is kept away from the ball while nothing changed", async () => {
  const { sim, loop, posts } = setup((body) =>
    Response.json(decideResponse(body)),
  );
  const a6 = place(sim, "a6", TRIAGE.nearM + 5);
  const h8 = place(sim, "h8", TRIAGE.nearM - 5);
  loop.tick(0);
  await loop.idle();
  assert.deepEqual(a6.decision.jev, { at: 0, local: "press" });
  assert.equal(a6.decision.source, "jev");
  // next round: a6 keeps "press" on the fresh state, h9 and h8 ask again
  sim.time = 1.2;
  loop.tick(1200);
  await loop.idle();
  assert.deepEqual(
    posts[1].body.decisions.map((d) => d.player_id),
    ["h9", "h8"],
  );
  const kept = sim.log.applied.filter((a) => a.id === "a6").at(-1);
  assert.equal(kept.batchId, a6.lastDecisionState.batch_id);
  assert.notEqual(kept.batchId, "b2");
  assert.deepEqual(
    [kept.choice, kept.meta.source, kept.meta.latencyMs],
    ["press", "jev", 0],
  );
  assert.deepEqual(kept.meta.probabilities, { press: 0.8, mark_h10: 0.2 });
  assert.deepEqual(a6.decision.jev, { at: 0, local: "press" }); // age keeps counting
  const t = loop.tally;
  assert.deepEqual(
    [t.calls, t.decisions, t.jevDecisions, t.kept, t.localDecisions],
    [2, 6, 5, 1, 0],
  );
  assert.equal(h8.decision.jev.at, 1.2);

  // keepable() says no as soon as anything moved
  const state = sim.decisionState(a6);
  const far = TRIAGE.nearM + 5;
  assert.equal(keepable(sim, a6, state, far).choice, "press");
  assert.equal(keepable(sim, a6, state, TRIAGE.nearM - 1), null); // near the ball
  sim.time = TRIAGE.keepS + 0.1;
  assert.equal(keepable(sim, a6, state, far), null); // too old
  sim.time = 1.2;
  assert.equal(keepable(sim, a6, { ...state, kind: "loose" }, far), null);
  assert.equal(
    keepable(sim, a6, { ...state, local: { choice: "mark_h10" } }, far),
    null, // the local policy reads the situation differently now
  );
  assert.equal(
    keepable(
      sim,
      a6,
      { ...state, options: { ...state.options, chase: {} } },
      far,
    ),
    null, // a new option appeared
  );
  assert.equal(
    keepable(
      sim,
      a6,
      { ...state, self: { ...state.self, has_ball: true } },
      far,
    ),
    null,
  );
  // Jev was torn last time: ask again
  const torn = {
    ...a6.decision,
    probabilities: { press: 0.45, mark_h10: 0.55 },
  };
  assert.equal(keepable(sim, { ...a6, decision: torn }, state, far), null);
  // a local decision is never "kept"
  a6.decision = { ...a6.decision, jev: undefined };
  assert.equal(keepable(sim, a6, state, far), null);
  // only_option answers are rules, not Jev's standing choice
  const fresh = sim.decisionState(a6);
  assert(
    applyJev(sim, a6, fresh, {
      batch_id: fresh.batch_id,
      choice: "press",
      source: "only_option",
    }),
  );
  assert.equal(a6.decision.source, "rule");
  assert.equal(a6.decision.jev, undefined);
});

test("triaged players decide locally, are tallied, and never reach the server", async () => {
  const { sim, loop, posts } = setup(
    (body) => Response.json(decideResponse(body)),
    { ids: ["h9", "a6", "a7"] },
  );
  place(sim, "a7", TRIAGE.deepM + 1);
  loop.tick(0);
  await loop.idle();
  assert.deepEqual(
    posts[0].body.decisions.map((d) => d.player_id),
    ["h9", "a6"],
  );
  assert.deepEqual(sim.log.local, ["a7"]);
  const t = loop.tally;
  assert.deepEqual(
    [t.decisions, t.jevDecisions, t.localDecisions, t.triaged, t.kept],
    [3, 2, 1, 1, 0],
  );
});

// ---- hosted mode hooks (docs/AUTH.md) ----------------------------------------
const CREDITS = {
  granted_usd: 0.25,
  purchased_usd: 0,
  remaining_usd: 0.2,
  spent_usd: 0.05,
  exhausted: false,
};

test("every POST carries a fresh request_id the server accepts", async () => {
  const { loop, posts } = setup((body) => Response.json(decideResponse(body)));
  loop.tick(0);
  await loop.idle();
  loop.tick(250);
  await loop.idle();
  const ids = posts.map((p) => p.body.request_id);
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9-]{16,80}$/);
  assert.notEqual(ids[0], ids[1]);
  assert(posts.every((p) => validBatch(p.body)));
  assert.deepEqual(Object.keys(posts[0].body).sort(), [
    "decisions",
    "request_id",
    "shared",
  ]);
});

test("credits from any response are kept and announced when they change", async () => {
  let credits = CREDITS;
  const { loop } = setup((body) =>
    Response.json(decideResponse(body, { credits })),
  );
  const seen = [];
  loop.onCredits = (c) => seen.push(c.remaining_usd);
  assert.equal(loop.credits, null);
  loop.tick(0);
  await loop.idle();
  loop.tick(250); // same balance: no second announcement
  await loop.idle();
  credits = { ...CREDITS, remaining_usd: 0.19 };
  loop.tick(500);
  await loop.idle();
  assert.deepEqual(seen, [0.2, 0.19]);
  assert.deepEqual(loop.credits, credits);
  loop.onCredits = () => {
    throw new Error("ui bug");
  };
  credits = { ...CREDITS, remaining_usd: 0.18 };
  loop.tick(750);
  await loop.idle();
  assert.equal(loop.credits.remaining_usd, 0.18);
});

test("401 auth_required, 402 credit_exhausted and 503 daily_cap hold the loop until resume()", async () => {
  const exhausted = { ...CREDITS, remaining_usd: 0, exhausted: true };
  const cases = [
    ["auth", 401, { error: "Sign in to play with Jev.", auth_required: true }],
    [
      "credit",
      402,
      {
        error: "Out of play credit.",
        code: "credit_exhausted",
        credits: exhausted,
      },
    ],
    ["cap", 503, { error: "Daily cap reached.", code: "daily_cap" }],
  ];
  for (const [held, status, payload] of cases) {
    let refuse = true;
    const release = [];
    const { sim, loop, posts, errors } = setup(
      (body) =>
        new Promise((resolve) =>
          release.push(() =>
            resolve(
              refuse
                ? Response.json(payload, { status })
                : Response.json(decideResponse(body)),
            ),
          ),
        ),
      { ids: ["h9", "h8", "h7", "a6", "a7", "a8"], maxBatch: 3 },
    );
    const calls = { auth: 0, credit: [], credits: [] };
    loop.onAuthRequired = () => calls.auth++;
    loop.onCreditExhausted = (c) => calls.credit.push(c);
    loop.onCredits = (c) => calls.credits.push(c);
    loop.tick(0);
    loop.tick(250); // two requests in flight, both will be refused
    assert.equal(posts.length, 2);
    release.forEach((go) => go());
    await loop.idle();
    assert.equal(loop.held, held, held);
    assert.equal(loop.configured, true);
    assert.equal(loop.backoffUntil, 0); // no backoff spiral
    assert.equal(loop.tally.errors, 2);
    assert.equal(errors.length, 1); // announced once
    assert.equal(calls.auth, held === "auth" ? 1 : 0);
    assert.deepEqual(calls.credit, held === "credit" ? [exhausted] : []);
    assert.deepEqual(calls.credits, held === "credit" ? [exhausted] : []);
    assert.deepEqual(loop.credits, held === "credit" ? exhausted : null);
    assert.equal(sim.log.local.length, 6); // the refused batches fell back
    // held: everyone local, nothing requested, however long it lasts
    for (const now of [500, 750, 60000]) loop.tick(now);
    await loop.idle();
    assert.equal(posts.length, 2);
    assert.equal(sim.log.local.length, 6 + 3 * 6);
    assert.equal(loop.tally.held, 18);
    assert(sim.players.every((p) => !p.pending));
    // after sign-in / top-up the UI resumes the loop
    refuse = false;
    loop.resume();
    assert.equal(loop.held, null);
    loop.tick(60250);
    release.at(-1)();
    await loop.idle();
    assert.equal(posts.length, 3);
    assert.equal(loop.tally.jevDecisions, 3);
  }
  // Local dev answers stay as they were: a plain 401/503 means "no usable key",
  // a plain 402 (Jev's own account) backs off and retries.
  for (const [status, configured] of [
    [401, false],
    [503, false],
    [402, true],
  ]) {
    const plain = setup(() => Response.json({ error: "nope" }, { status }));
    let fired = 0;
    plain.loop.onAuthRequired = plain.loop.onCreditExhausted = () => fired++;
    plain.loop.tick(0);
    await plain.loop.idle();
    assert.equal(plain.loop.held, null);
    assert.equal(plain.loop.configured, configured);
    assert.equal(plain.loop.backoffUntil, status === 402 ? 1000 : 0);
    assert.equal(fired, 0);
  }
});
