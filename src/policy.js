// Local "football brain": a hand-written utility per candidate, softmaxed into probabilities.
// It is the free-play decision-maker and the fallback whenever Jev is unavailable or late.
import { clamp } from "./math.js";

const TEMPERATURE = 0.16;
const FORWARD = new Set(["ST", "LW", "RW", "AM", "LM", "RM"]);
const BACK = new Set(["CB", "LB", "RB", "DM", "LWB", "RWB"]);
const CENTRAL_BACK = new Set(["CB", "DM"]);

const n = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

function carrierUtility(o, s, keeper) {
  const f = o.features,
    self = s.self,
    pressed = self.pressure_m < 3,
    deep = self.x < -17,
    stale = clamp((self.held_s - 3.5) * 0.12, 0, 0.5);
  switch (o.action) {
    case "shoot": {
      let u = 0.55 + 4 * n(f.xg) - (f.dist_m > 27 ? 0.35 : 0) - (f.blockers >= 2 ? 0.2 : 0);
      if (f.blockers === 0 && f.pressure_m > 2 && f.angle_deg > 11) u += 0.18; // sight of goal and time to hit it
      if (f.xg >= 0.22) u += 0.35; // a real chance: don't overthink it
      if (f.dist_m < 17 && f.angle_deg > 17 && f.blockers === 0) u += 0.2;
      return u;
    }
    case "pass": {
      const p = n(f.success_p),
        prog = n(f.progress_m);
      let u = p * 0.78 + (prog >= 0 ? clamp(prog / 25, 0, 1) * 0.75 : clamp(prog / 30, -1, 0) * 0.22) +
        clamp(n(f.receiver_space_m) / 9, 0, 1) * 0.14;
      if (deep) u -= (1 - p) * 0.55; // no gambling in front of our own goal
      if (pressed) u += 0.14;
      if (/^[ha]1$/.test(o.target_id ?? "")) u -= pressed ? 0.05 : 0.22;
      // take a touch and look up first unless someone is already closing in
      if (s.kind === "carrier" && self.pressure_m > 2.5) u -= clamp((1.4 - self.held_s) * 0.3, 0, 0.4);
      if (s.kind === "restart" || keeper) u += 0.1 + (f.lofted ? -0.12 : 0);
      return u + stale;
    }
    case "through":
      return n(f.success_p) * 0.95 + clamp(n(f.progress_m) / 30, 0, 1) * 0.35 + 0.15 + stale;
    case "cross":
      return 0.5 + 0.13 * Math.min(n(f.targets), 3) + n(f.success_p) * 0.35 + (s.kind === "restart" ? 0.5 : 0) + stale;
    case "dribble": {
      const space = clamp(n(f.space_m) / 11, 0, 1),
        prog = clamp(n(f.progress_m) / 7, -1, 1);
      let u = 0.36 + space * 0.46 + prog * 0.26 - (f.pressure_m < 2.6 ? 0.34 : 0);
      if (pressed && f.space_m < 6) u -= 0.2;
      if (self.pressure_m < 1.6) u -= 0.18; // someone is on your shoulder: move it on
      u -= clamp((30 - self.goal_dist_m) / 14, 0, 1) * 0.3; // near goal: look for the shot or the final ball instead
      return u - stale * 0.4;
    }
    case "clear":
      if (keeper) return 0.52 + clamp((self.held_s - 2) * 0.2, 0, 0.6);
      return 0.1 + (self.pressure_m < 3.2 ? 0.4 : 0) + (self.pressure_m < 1.8 ? 0.25 : 0) + (self.x < -35 ? 0.2 : 0) + stale;
    case "hold":
      if (keeper) return 0.78 - 0.3 * self.held_s;
      return 0.3 - 0.14 * self.held_s - (self.pressure_m < 4.5 ? 0.4 : 0);
  }
  return 0;
}

function attackUtility(o, s, id) {
  const f = o.features,
    role = s.role,
    near = clamp(1 - n(f.dist_m) / 30, 0, 1);
  if (id === "shape") return 0.55 + (CENTRAL_BACK.has(role) ? 0.2 : 0);
  if (id === "support_near")
    return 0.3 + clamp(n(f.lane_clear_m) / 6, 0, 1) * 0.22 + clamp(n(f.space_m) / 8, 0, 1) * 0.16 + near * 0.18 -
      (CENTRAL_BACK.has(role) ? 0.18 : 0);
  if (id === "support_wide")
    return (s.self.wide_role ? 0.5 : 0.12) + clamp(n(f.space_m) / 10, 0, 1) * 0.2 + near * 0.1 - (n(f.dist_m) > 30 ? 0.2 : 0);
  if (id === "run_behind")
    return (FORWARD.has(role) ? 0.58 : BACK.has(role) ? 0.05 : 0.3) + clamp(n(f.space_m) / 10, 0, 1) * 0.18 +
      clamp(n(f.lane_clear_m) / 6, 0, 1) * 0.12 - (n(f.progress_m) > 45 ? 0.25 : 0) - (n(f.offside_margin_m) < 0 ? 0.3 : 0);
  return 0.2;
}

function defendUtility(o, s, id) {
  const f = o.features,
    role = s.role;
  if (id === "press") {
    // only the best-placed one or two go to the ball; everyone else keeps the block
    // …and the press gets fiercer the closer the ball is to our goal; high up it is only token
    const base = f.rank === 1 ? 0.72 + n(f.danger) * 0.6 : f.rank === 2 ? 0.3 + n(f.danger) * 0.6 : 0.05;
    return base - clamp((n(f.eta_s) - 2.2) * 0.2, 0, 0.6) - (f.rank > 1 && CENTRAL_BACK.has(role) ? 0.15 : 0);
  }
  if (o.action === "mark")
    return 0.46 + n(f.danger) * 0.42 - n(f.dist_m) * 0.014 - (n(f.space_m) < 2.5 ? 0.35 : 0) + (BACK.has(role) ? 0.06 : 0);
  if (id === "cover") return 0.42 + n(f.danger) * 0.3 + (BACK.has(role) ? 0.1 : 0) - (f.rank > 2 ? 0.25 : 0) - n(f.dist_m) * 0.004;
  if (id === "shape") return 0.6;
  if (id === "chase") return n(f.eta_s) < n(f.opp_eta_s) ? 1.2 : 0.75;
  return 0.2;
}

function looseUtility(o, s, id) {
  const f = o.features;
  if (id === "chase") {
    const first = n(f.eta_s) <= n(f.mate_eta_s) + 0.05,
      wins = n(f.eta_s) < n(f.opp_eta_s);
    if (first) return wins ? 1.35 : 1.05;
    // second man follows up only if he is genuinely close
    if (n(f.eta_s) <= n(f.mate_eta_s) + 0.7 && n(f.eta_s) < 2.5) return 0.62;
    return wins ? 0.3 : 0.05;
  }
  if (id === "shape") return 0.55;
  if (id === "cover") return 0.4 + n(f.danger) * 0.3 + (BACK.has(s.role) ? 0.1 : 0) - (f.rank > 2 ? 0.25 : 0);
  if (id === "support_near") return 0.45;
  return 0.2;
}

function keeperUtility(o, s, id) {
  const f = o.features;
  if (id === "gk_set") return 0.6;
  if (id === "gk_rush") return n(f.eta_s) < n(f.opp_eta_s) - 0.3 && n(f.eta_s) < 3.2 ? 1.2 : 0.1;
  if (id === "gk_claim") return n(f.eta_s) < n(f.opp_eta_s) + 0.1 ? 1.15 : 0.25;
  return 0.2;
}

export function utilities(state) {
  const out = {},
    ballWork = state.kind === "carrier" || state.kind === "restart" || (state.kind === "keeper" && state.self.has_ball);
  for (const [id, o] of Object.entries(state.options)) {
    let u;
    if (ballWork) u = carrierUtility(o, state, state.kind === "keeper");
    else if (state.kind === "keeper") u = keeperUtility(o, state, id);
    else if (state.kind === "attack") u = attackUtility(o, state, id);
    else if (state.kind === "defend") u = defendUtility(o, state, id);
    else u = looseUtility(o, state, id);
    // mild commitment to the current plan so off-ball players don't flicker between near-ties
    if (!ballWork && id === state.self.prev_choice) u += 0.07;
    out[id] = Number.isFinite(u) ? u : 0;
  }
  return out;
}

export function localPolicy(state, rng) {
  const u = utilities(state),
    ids = Object.keys(u);
  if (!ids.length) return { choice: null, probabilities: {} };
  const max = Math.max(...ids.map((id) => u[id]));
  let sum = 0;
  const probabilities = {};
  for (const id of ids) sum += probabilities[id] = Math.exp((u[id] - max) / TEMPERATURE);
  let choice = ids[0];
  for (const id of ids) {
    probabilities[id] = Math.round((probabilities[id] / sum) * 1000) / 1000;
    if (probabilities[id] > probabilities[choice]) choice = id;
  }
  if (rng) {
    // sample only among genuinely competitive options: a carrier decides several times a second,
    // so giving 3 % choices a seat at the table would make them happen constantly
    const floor = probabilities[choice] * 0.4,
      pool = ids.filter((id) => probabilities[id] >= floor);
    let r = rng() * pool.reduce((a, id) => a + probabilities[id], 0);
    for (const id of pool) {
      r -= probabilities[id];
      if (r <= 0) {
        choice = id;
        break;
      }
    }
  }
  return { choice, probabilities };
}
