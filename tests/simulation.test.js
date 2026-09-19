import test from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/simulation.js";
import { PITCH } from "../src/pitch.js";

function run(sim, seconds, each) {
  for (let i = 0; i < seconds * 60 && sim.phase !== "fulltime"; i++) {
    sim.step(1 / 60);
    for (const p of sim.decisionDue()) sim.decideLocally(p);
    each?.(sim);
  }
  return sim;
}
const fingerprint = (sim) =>
  JSON.stringify([sim.score, sim.ball.x, sim.ball.y, sim.players.map((p) => [p.x, p.y])]);

test("the same seed replays the same match", () => {
  assert.equal(fingerprint(run(new Simulation(11), 40)), fingerprint(run(new Simulation(11), 40)));
  assert.notEqual(fingerprint(run(new Simulation(11), 40)), fingerprint(run(new Simulation(12), 40)));
});

test("22 players with contract ids, and the ball never escapes the stadium", () => {
  const sim = new Simulation(3, { halfSeconds: 45 });
  assert.deepEqual(
    sim.players.map((p) => p.id).sort(),
    [0, 1].flatMap((t) => Array.from({ length: 11 }, (_, i) => `${"ha"[t]}${i + 1}`)).sort(),
  );
  run(sim, 60, (s) => {
    assert(Math.abs(s.ball.x) < PITCH.halfL + 12 && Math.abs(s.ball.y) < PITCH.halfW + 12, `ball lost at ${s.time}`);
    for (const p of s.players) assert(Number.isFinite(p.x) && Number.isFinite(p.y), `${p.id} position`);
  });
});

test("a short match reaches full time through half time, swapping ends", () => {
  const sim = new Simulation(5, { halfSeconds: 30 });
  assert.equal(sim.attackDir(0), 1);
  assert.equal(sim.attackDir(1), -1);
  run(sim, 200);
  assert.equal(sim.phase, "fulltime");
  assert.equal(sim.clock.half, 2);
  assert.equal(sim.attackDir(0), -1);
  const types = new Set(sim.events.map((e) => e.type));
  for (const type of ["halftime", "fulltime"]) assert(types.has(type), type);
  assert(sim.stats.passes[0] > 0 && sim.stats.passes[1] > 0);
});

test("a ball over the line between the posts is a goal followed by a kickoff", () => {
  const sim = run(new Simulation(8), 5);
  const b = sim.ball;
  Object.assign(b, { ownerId: null, x: PITCH.halfL - 1.5, y: 0.5, z: 0.3, vx: 24, vy: 0, vz: 0, flight: null });
  for (const p of sim.players) if (p.role === "GK") p.y = 30; // keepers out of the way
  b.lastTouchTeam = 0;
  for (let i = 0; i < 30 && sim.phase === "play"; i++) sim.step(1 / 60);
  assert.deepEqual(sim.score, [1, 0]);
  assert.equal(sim.phase, "goal");
  run(sim, 12);
  assert(["kickoff", "play", "restart"].includes(sim.phase));
  assert(sim.events.some((e) => e.type === "goal" && e.team === 0));
});

test("stale batches, unknown options and foreign players are rejected", () => {
  const sim = run(new Simulation(4), 6);
  const carrier = sim.owner() ?? sim.players.find((p) => p.role === "CM");
  const state = sim.decisionState(carrier);
  const choice = Object.keys(state.options)[0];
  assert.equal(sim.applyDecision(carrier.id, "b0", choice, { source: "jev" }), false);
  assert.equal(sim.applyDecision(carrier.id, state.batch_id, "fly_away", { source: "jev" }), false);
  assert.equal(sim.applyDecision("h99", state.batch_id, choice, { source: "jev" }), false);
  assert.equal(
    sim.applyDecision(carrier.id, state.batch_id, choice, { source: "jev", probabilities: { [choice]: 1 }, confidence: 1 }),
    true,
  );
  assert.equal(carrier.decision.source, "jev");
  assert.equal(carrier.decision.choice, choice);
});

test("a human can take over a player, move, and hand control back", () => {
  const sim = run(new Simulation(2), 4);
  sim.setHuman("h9");
  const me = sim.player("h9");
  assert.equal(me.isHuman, true);
  assert(!sim.decisionDue().includes(me));
  const x0 = me.x;
  Object.assign(sim.humanInput, { mx: 1, my: 0, sprint: true });
  run(sim, 1.5);
  assert(me.x > x0 + 3, `moved ${me.x - x0} m`);
  sim.humanInput.pass = true;
  sim.humanInput.shoot = true;
  run(sim, 0.2); // flags are consumed without throwing, with or without the ball
  assert.equal(sim.humanInput.pass, false);
  assert.equal(sim.humanInput.shoot, false);
  sim.setHuman(null);
  assert.equal(sim.human, null);
  assert.equal(me.isHuman, false);
});

test("sharedState is compact JSON for one Jev request", () => {
  const shared = run(new Simulation(6), 3).sharedState();
  assert.equal(shared.players.length, 22);
  assert(shared.players.every((row) => row.length === 6));
  assert(JSON.stringify(shared).length < 2500);
  assert.deepEqual(JSON.parse(JSON.stringify(shared)), shared);
});
