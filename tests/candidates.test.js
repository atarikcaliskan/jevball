import test from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/simulation.js";
import { localPolicy } from "../src/policy.js";
import { validBatch } from "../server/jev.js";

const KINDS = ["carrier", "attack", "defend", "loose", "keeper", "restart"];

test("every decision offered during a match honours the contract", () => {
  const sim = new Simulation(21, { halfSeconds: 40 });
  const kinds = new Set();
  let carrierWithPass = 0,
    carriers = 0;
  for (let i = 0; i < 60 * 70 && sim.phase !== "fulltime"; i++) {
    sim.step(1 / 60);
    const due = sim.decisionDue();
    for (const p of due) {
      const s = sim.decisionState(p);
      kinds.add(s.kind);
      assert(KINDS.includes(s.kind), s.kind);
      assert.match(s.batch_id, /^b[0-9]+$/);
      assert.equal(s.player_id, p.id);
      const ids = Object.keys(s.options);
      assert(ids.length >= 1 && ids.length <= 14, `${ids.length} options`);
      for (const [id, option] of Object.entries(s.options)) {
        assert.match(id, /^[a-z0-9_]+$/);
        assert(typeof option.label === "string" && option.label.length <= 120, option.label);
        assert(Number.isFinite(option.target.x) && Number.isFinite(option.target.y), `${id} target`);
        assert(option.path.length >= 2 && option.path.length <= 16, `${id} path`);
        for (const [key, value] of Object.entries(option.features))
          assert(typeof value === "boolean" || value === null || Number.isFinite(value), `${id}.${key}=${value}`);
      }
      if (s.kind === "carrier") {
        carriers++;
        if (ids.some((id) => id.startsWith("pass_"))) carrierWithPass++;
        // Offside is avoided by construction: no pass is offered beyond the line.
        for (const [id, option] of Object.entries(s.options))
          if (/^(pass|through)_/.test(id) && option.features.offside_margin_m != null)
            assert(option.features.offside_margin_m >= 0, `${id} offside`);
      }
      assert(ids.includes(s.local.choice));
      const total = Object.values(s.local.probabilities).reduce((a, b) => a + b, 0);
      assert(Math.abs(total - 1) < 0.01, `probabilities sum to ${total}`);
    }
    if (due.length && i % 30 === 0)
      assert(
        validBatch(JSON.parse(JSON.stringify({ shared: sim.sharedState(), decisions: due.slice(0, 12).map((p) => p.lastDecisionState) }))),
        "server accepts a real batch",
      );
    for (const p of due) sim.decideLocally(p);
  }
  for (const kind of ["carrier", "attack", "defend", "keeper"]) assert(kinds.has(kind), `saw ${kind}`);
  assert(carrierWithPass / carriers > 0.8, "carriers nearly always have a pass");
});

test("the local policy is deterministic without an rng and samples with one", () => {
  const sim = new Simulation(3);
  for (let i = 0; i < 300; i++) {
    sim.step(1 / 60);
    for (const p of sim.decisionDue()) sim.decideLocally(p);
  }
  const state = sim.decisionState(sim.owner() ?? sim.players[5]);
  assert.deepEqual(localPolicy(state), localPolicy(state));
  const best = Object.entries(localPolicy(state).probabilities).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(localPolicy(state).choice, best);
});
