// Live end-to-end check: a real match driven through the real Jev API, scheduled
// by the same planBatch() the browser loop uses, so the bill measured here is
// the bill the browser runs up (the browser additionally caps requests in flight).
// npm run test:jev   (SECONDS=30 SEED=42 MAX_BATCH=12 are optional)
// TRIAGE=0 asks Jev for every due decision (the pre-triage baseline);
// AUDIT_KEEP=1 re-asks Jev where his standing choice would have been kept and
// reports how often the fresh answer is the same (costs like TRIAGE=0).
import { evaluate } from "../server/jev.js";
import {
  planBatch,
  applyJev,
  applyKept,
  TRIAGE,
} from "../src/decision-loop.js";

if (
  !process.env.TYPESAFE_API_KEY ||
  process.env.TYPESAFE_API_KEY === "your_key_here"
) {
  console.error(
    "TYPESAFE_API_KEY is missing. Copy .env.example to .env, add your key, then run npm run test:jev.",
  );
  process.exit(1);
}
const { Simulation } = await import("../src/simulation.js");

const seconds = Number(process.env.SECONDS || 30),
  maxBatch = Math.min(12, Number(process.env.MAX_BATCH || 12)),
  auditKeep = process.env.AUDIT_KEEP === "1",
  rules =
    process.env.TRIAGE === "0"
      ? {
          ...TRIAGE,
          farM: Infinity,
          deepM: Infinity,
          nearM: Infinity,
          minBatch: 1,
        }
      : TRIAGE;
const sim = new Simulation(Number(process.env.SEED || 42));
const started = Date.now();
let calls = 0,
  decisions = 0,
  local = 0,
  triaged = 0,
  kept = 0,
  stale = 0,
  invalid = 0,
  agreed = 0,
  onBall = 0,
  onBallAgreed = 0,
  inputTokens = 0,
  requestBytes = 0,
  latency = 0,
  cost = 0;
const errors = [];
const top = (probabilities) =>
  Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, p]) => `${id}:${p.toFixed(2)}`)
    .join(" ");
const decideLocally = (p) => {
  sim.decideLocally(p);
  local++;
};

const audit = { asked: 0, same: 0, by_standing_confidence: {} };
// The audit looks below the confidence gate too, to show where it belongs.
const planRules = auditKeep ? { ...rules, keepConfidence: 0 } : rules;
let waiting = new Map();

while (sim.time < seconds && sim.phase !== "fulltime") {
  // Lockstep: the match waits for each answer, so "now" is match time.
  const plan = planBatch(sim, sim.decisionDue(), {
    now: sim.time * 1000,
    waiting,
    maxBatch,
    rules: planRules,
  });
  waiting = plan.waiting;
  // Single-option and starved players never reach Jev, as in the browser.
  for (const p of plan.local) decideLocally(p);
  for (const p of plan.triaged) {
    decideLocally(p);
    triaged++;
  }
  const batch = plan.send.map(({ player, state }) => ({ p: player, state }));
  for (const k of plan.kept) {
    if (auditKeep && batch.length < maxBatch)
      batch.push({ p: k.player, state: k.state, standing: k.previous });
    else if (applyKept(sim, k)) kept++;
    else decideLocally(k.player);
  }
  if (batch.length) {
    let result = null;
    try {
      result = await evaluate(
        { shared: sim.sharedState(), decisions: batch.map((b) => b.state) },
        process.env,
      );
    } catch (e) {
      errors.push(`${e.status ?? e.name}: ${e.message}`);
      console.error(`call ${calls + 1} failed: ${e.message}`);
      if ([401, 402].includes(e.status)) {
        for (const { p } of batch) decideLocally(p);
        break;
      }
    }
    if (result) {
      calls++;
      cost += result.cost_usd;
      inputTokens += result.usage.input_tokens;
      requestBytes += result.request_bytes;
      latency += result.latency_ms;
      invalid += result.invalid.length;
    }
    let sample = null;
    for (const { p, state, standing } of batch) {
      const answer = result?.decisions[p.id];
      const ok = answer && applyJev(sim, p, state, answer, result.latency_ms);
      if (ok && standing) {
        const was = standing.probabilities?.[standing.choice] ?? 0,
          bucket = was >= 0.6 ? ">=0.6" : was >= 0.5 ? "0.5-0.6" : "<0.5",
          b = (audit.by_standing_confidence[bucket] ??= { asked: 0, same: 0 });
        b.asked++;
        if (answer.choice === standing.choice) b.same++;
        if (was >= rules.keepConfidence) {
          // what the browser would really have kept
          audit.asked++;
          if (answer.choice === standing.choice) audit.same++;
        }
      }
      if (!ok) {
        if (answer) stale++;
        decideLocally(p);
        continue;
      }
      decisions++;
      if (answer.choice === state.local?.choice) agreed++;
      if (state.kind === "restart" || state.self.has_ball) {
        onBall++;
        if (answer.choice === state.local?.choice) onBallAgreed++;
      }
      sample ??= {
        player: `${p.id} ${state.role} ${state.kind}`,
        choice: state.options[answer.choice].label,
        top: top(answer.probabilities),
        local: state.local?.choice,
      };
    }
    if (result && (calls === 1 || calls % 20 === 0))
      console.log(
        JSON.stringify({
          call: calls,
          minute: sim.clock.minute,
          score: sim.score.join("-"),
          questions: Object.keys(result.request?.questions ?? {}).length,
          sample,
          latency_ms: result.latency_ms,
          input_tokens: result.usage.input_tokens,
          cost,
        }),
      );
  }
  // ~0.25 s of football between batches, like the browser loop's tick.
  for (let i = 0; i < 15; i++) sim.step(1 / 60);
}

console.log(
  JSON.stringify(
    {
      seed: sim.seed,
      sim_seconds: Math.round(sim.time),
      wall_seconds: (Date.now() - started) / 1000,
      score: sim.score,
      calls,
      jev_decisions: decisions,
      kept_decisions: kept, // Jev's standing choice re-applied, no question asked
      local_decisions: local, // includes triaged
      triaged_decisions: triaged,
      jev_on_ball_decisions: onBall,
      stale,
      invalid_answers: invalid,
      questions_per_call: calls ? Math.round((decisions / calls) * 10) / 10 : 0,
      average_input_tokens: calls ? Math.round(inputTokens / calls) : 0,
      average_request_bytes: calls ? Math.round(requestBytes / calls) : 0,
      total_input_tokens: inputTokens,
      average_latency_ms: calls ? Math.round(latency / calls) : 0,
      total_cost_usd: cost,
      cost_per_match_minute_usd: sim.time ? (cost / sim.time) * 60 : 0,
      local_agreement: decisions
        ? Math.round((agreed / decisions) * 1000) / 1000
        : null,
      local_agreement_on_ball: onBall
        ? Math.round((onBallAgreed / onBall) * 1000) / 1000
        : null,
      ...(auditKeep && {
        keep_audit: {
          ...audit,
          same_rate: audit.asked
            ? Math.round((audit.same / audit.asked) * 1000) / 1000
            : null,
        },
      }),
      errors,
      events: sim.events.filter((e) => e.type !== "decision").slice(-25),
    },
    null,
    1,
  ),
);
if (errors.length || !calls) process.exitCode = 1;
