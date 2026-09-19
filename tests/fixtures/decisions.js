// Hand-written snapshots that follow docs/ARCHITECTURE.md, so the Jev tests
// never depend on the simulation module. Home attacks +x (first half).
const HOME = [
  ["h1", "GK", -47, 0],
  ["h2", "RB", -18, -22],
  ["h3", "LB", -18, 22],
  ["h4", "CB", -26, -7],
  ["h5", "CB", -26, 7],
  ["h6", "CM", -2, -6],
  ["h7", "RM", 18, -24],
  ["h8", "CM", 4, 8],
  ["h9", "ST", 31.4, 3.2],
  ["h10", "ST", 33, -9],
  ["h11", "LM", 16, 25],
];
const AWAY = [
  ["a1", "GK", 49.5, 0.4],
  ["a2", "RB", 36, 20],
  ["a3", "LB", 37, -19],
  ["a4", "CB", 39, -5],
  ["a5", "CB", 38.5, 6],
  ["a6", "DM", 29, 1],
  ["a7", "RW", 8, 24],
  ["a8", "CM", 24, -8],
  ["a9", "ST", -12, 2],
  ["a10", "CM", 22, 10],
  ["a11", "LW", 6, -26],
];

export const sharedState = () => ({
  minute: 63,
  half: 1,
  score: [1, 0],
  phase: "play",
  restart: null,
  possession: "home",
  ball: { x: 31.8, y: 3.1, z: 0, vx: 2.1, vy: -0.4, owner: "h9", flight: null },
  players: [...HOME, ...AWAY].map(([id, role, x, y], i) => [
    id,
    role,
    x,
    y,
    ((i % 5) - 2) * 0.7,
    ((i % 3) - 1) * 0.5,
  ]),
});

const path = (from, to) =>
  [0, 0.5, 1].map((t) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: 0,
  }));
const option = (from, action, target_id, target, label, features) => ({
  action,
  target_id,
  target,
  label,
  features,
  path: path(from, target),
});

export function carrierDecision(batch = "b417") {
  const at = { x: 31.4, y: 3.2 };
  return {
    batch_id: batch,
    player_id: "h9",
    team: "home",
    role: "ST",
    number: 9,
    kind: "carrier",
    self: {
      x: 31.4,
      y: 3.2,
      speed: 4.26,
      has_ball: true,
      pressure_m: 2.84,
      goal_dist_m: 21.3,
      goal_angle_deg: 17.6,
      nearest_teammate_m: 12.3,
    },
    options: {
      shoot: option(
        at,
        "shoot",
        null,
        { x: 52.5, y: -1.8 },
        "Shoot from 21 m, 2 blockers",
        {
          dist_m: 21.34,
          xg: 0.0712,
          angle_deg: 17.6,
          blockers: 2,
          danger: 0.1,
        },
      ),
      pass_h10: option(
        at,
        "pass",
        "h10",
        { x: 33, y: -9 },
        "Pass to h10 (ST) 12 m, open",
        {
          dist_m: 12.3,
          progress_m: 1.6,
          lane_clear_m: 3.4,
          receiver_space_m: 5.1,
          success_p: 0.874,
          danger: 0.1,
        },
      ),
      through_h7: option(
        at,
        "through",
        "h7",
        { x: 40, y: -22 },
        "Through ball for h7 (RM) 27 m",
        {
          dist_m: 26.6,
          progress_m: 8.6,
          lane_clear_m: 1.2,
          receiver_space_m: 8,
          success_p: 0.41,
          offside_margin_m: 1.5,
          danger: 0.1,
        },
      ),
      dribble_fwd: option(
        at,
        "dribble",
        null,
        { x: 37.4, y: 3.2 },
        "Dribble forward 6 m, tight",
        {
          progress_m: 6,
          space_m: 2.1,
          success_p: 0.35,
          danger: 0.1,
        },
      ),
      hold: option(at, "hold", null, at, "Shield the ball", {
        space_m: 2.8,
        success_p: 0.6,
        danger: 0.1,
      }),
    },
    local: {
      choice: "pass_h10",
      probabilities: {
        shoot: 0.1,
        pass_h10: 0.5,
        through_h7: 0.2,
        dribble_fwd: 0.1,
        hold: 0.1,
      },
    },
  };
}

export function defenderDecision(batch = "b418") {
  const at = { x: 29, y: 1 };
  return {
    batch_id: batch,
    player_id: "a6",
    team: "away",
    role: "DM",
    number: 6,
    kind: "defend",
    self: {
      x: 23.5,
      y: -1,
      speed: 3.1,
      has_ball: false,
      pressure_m: 2.8,
      goal_dist_m: 81.5,
      goal_angle_deg: 5,
      nearest_teammate_m: 9.8,
    },
    options: {
      press: option(
        at,
        "press",
        "h9",
        { x: 31.4, y: 3.2 },
        "Press h9, 3 m away",
        {
          dist_m: 3.3,
          eta_s: 0.6,
          danger: 0.6,
        },
      ),
      mark_h10: option(
        at,
        "mark",
        "h10",
        { x: 34.5, y: -8 },
        "Mark h10 (ST), free in the box channel",
        {
          dist_m: 10.5,
          eta_s: 1.9,
          danger: 0.5,
        },
      ),
      cover: option(
        at,
        "cover",
        null,
        { x: 40, y: 1.5 },
        "Cover the path to goal",
        {
          dist_m: 11,
          eta_s: 2,
          danger: 0.6,
        },
      ),
      shape: option(at, "shape", null, { x: 32, y: 0 }, "Hold formation slot", {
        dist_m: 3.2,
        eta_s: 0.7,
        danger: 0.6,
      }),
    },
    local: {
      choice: "press",
      probabilities: { press: 0.7, mark_h10: 0.1, cover: 0.1, shape: 0.1 },
    },
  };
}

export function singleOptionDecision(batch = "b419") {
  const at = { x: -47, y: 0 };
  return {
    batch_id: batch,
    player_id: "h1",
    team: "home",
    role: "GK",
    number: 1,
    kind: "keeper",
    self: {
      x: -47,
      y: 0,
      speed: 0.2,
      has_ball: false,
      pressure_m: 35,
      goal_dist_m: 99.5,
      goal_angle_deg: 4,
      nearest_teammate_m: 22,
    },
    options: {
      gk_set: option(
        at,
        "gk_set",
        null,
        { x: -48.5, y: 0.3 },
        "Stay set on the goal line",
        {
          dist_m: 1.5,
          danger: 0.05,
        },
      ),
    },
    local: { choice: "gk_set", probabilities: { gk_set: 1 } },
  };
}

export const batch = () => ({
  shared: sharedState(),
  decisions: [carrierDecision(), defenderDecision(), singleOptionDecision()],
});

// What Jev would return: `choices[player]` wins with p=0.7 (default: first option).
export function jevResponse(request, choices = {}) {
  return {
    model: "jev-latest",
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        const ids = Object.keys(q.criteria),
          choice = choices[id] ?? ids[0];
        return [
          id,
          {
            type: "choice",
            choice,
            confidence: 0.7,
            probabilities: Object.fromEntries(
              ids.map((o) => [o, o === choice ? 0.7 : 0.3 / (ids.length - 1)]),
            ),
          },
        ];
      }),
    ),
    usage: { input_tokens: 2000, output_tokens: 80 },
  };
}

// Minimal stand-in for Simulation: every player is always due with a
// two-option decision, and calls are recorded for assertions. h9 (when
// playing) carries the ball, so his batch is urgent; players have no position
// unless a test gives them one (no position = next to the ball).
export class FakeSim {
  constructor(ids = ["h9", "a6", "h8"]) {
    this.time = 0;
    this.paused = false;
    this.batch = 0;
    this.players = ids.map((id) => ({ id, pending: false, nextDecisionAt: 0 }));
    this.ball = { x: 31.8, y: 3.1, ownerId: ids.includes("h9") ? "h9" : null };
    this.restart = null;
    this.log = { local: [], applied: [], rejected: [] };
    this.rejectAll = false;
    this.singleOption = new Set();
  }
  decisionDue() {
    return this.players.filter((p) => !p.pending);
  }
  decisionState(p) {
    const base = p.id[0] === "h" ? carrierDecision() : defenderDecision();
    const ids = Object.keys(base.options).slice(
      0,
      this.singleOption.has(p.id) ? 1 : 2,
    );
    p.lastDecisionState = {
      ...base,
      batch_id: `b${++this.batch}`,
      player_id: p.id,
      team: p.id[0] === "h" ? "home" : "away",
      number: Number(p.id.slice(1)),
      options: Object.fromEntries(ids.map((id) => [id, base.options[id]])),
    };
    return p.lastDecisionState;
  }
  sharedState() {
    return sharedState();
  }
  applyDecision(id, batchId, choice, meta) {
    const p = this.players.find((x) => x.id === id);
    const ok =
      !this.rejectAll &&
      p?.lastDecisionState?.batch_id === batchId &&
      Object.hasOwn(p.lastDecisionState.options, choice);
    this.log[ok ? "applied" : "rejected"].push({ id, batchId, choice, meta });
    if (ok)
      p.decision = {
        batchId,
        kind: p.lastDecisionState.kind,
        choice,
        ...meta,
        at: this.time,
      };
    return ok;
  }
  decideLocally(p) {
    this.log.local.push(p.id);
  }
}
