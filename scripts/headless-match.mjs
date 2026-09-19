// Full match with the local policy only. Usage: SEED=7 HALF_SECONDS=180 node scripts/headless-match.mjs
// QUIET=1 prints just the final stats JSON (handy when sweeping seeds while tuning).
import { Simulation } from "../src/simulation.js";

const seed = Number(process.env.SEED ?? 1),
  halfSeconds = Number(process.env.HALF_SECONDS ?? 180),
  quiet = !!process.env.QUIET,
  formations = (process.env.FORMATIONS ?? "4-4-2,4-3-3").split(",");

const sim = new Simulation(seed, { formations, halfSeconds }),
  started = performance.now(),
  TIMELINE = new Set(["kickoff", "goal", "shot", "save", "corner", "goal_kick", "halftime", "fulltime"]),
  restarts = {},
  kinds = {},
  choices = {};
let seen = 0,
  steps = 0,
  inPlay = 0;
const logged = new WeakSet();

const drain = () => {
  // events are capped at 200, so track identity rather than an index
  for (const e of sim.events) {
    if (logged.has(e)) continue;
    logged.add(e);
    seen++;
    if (["throw_in", "corner", "goal_kick"].includes(e.type)) restarts[e.type] = (restarts[e.type] ?? 0) + 1;
    if (!quiet && TIMELINE.has(e.type)) console.log(`${String(e.minute).padStart(2)}' [${e.t.toFixed(1).padStart(6)}s] ${e.type.padEnd(9)} ${e.text}`);
  }
};

const limit = (halfSeconds * 2 + 600) * 60 * 3;
while (sim.phase !== "fulltime" && steps < limit) {
  sim.step(1 / 60);
  for (const p of sim.decisionDue()) {
    sim.decideLocally(p);
    const d = p.decision;
    if (d) {
      kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
      const k = d.choice.replace(/_(?:[ha]\d+)$/, "");
      choices[k] = (choices[k] ?? 0) + 1;
    }
  }
  if (sim.phase === "play") inPlay++;
  steps++;
  drain();
}

const s = sim.stats,
  pct = (a, b) => (b ? Math.round((a / b) * 100) : 0),
  possTotal = s.possessionTime[0] + s.possessionTime[1];
const summary = {
  seed,
  halfSeconds,
  finished: sim.phase === "fulltime",
  score: sim.score,
  shots: s.shots,
  onTarget: s.onTarget,
  passes: s.passes,
  passCompletionPct: [pct(s.passesCompleted[0], s.passes[0]), pct(s.passesCompleted[1], s.passes[1])],
  possessionPct: [pct(s.possessionTime[0], possTotal), pct(s.possessionTime[1], possTotal)],
  tackles: s.tackles,
  saves: s.saves,
  corners: s.corners,
  restarts,
  ballInPlayPct: pct(inPlay, steps),
  decisions: sim.decisionsMade,
  decisionKinds: kinds,
  choices,
  events: seen,
  simSeconds: Math.round(sim.time),
  wallMs: Math.round(performance.now() - started),
};
console.log(JSON.stringify(summary, null, quiet ? 0 : 2));
if (!summary.finished) process.exit(1);
