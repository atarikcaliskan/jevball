// Candidate generation: everything geometric is computed here, locally and honestly, so the
// decision-maker (Jev or the local policy) only has to pick among typed, pre-scored options.
// Also hosts the ball flight model, because a candidate kick *is* a planned ball trajectory.
import { PITCH, TEAMS, WIDE_ROLES } from "./pitch.js";
import { clamp, lerp, round, dist, pointSegment, deg, smoothstep } from "./math.js";
import { localPolicy } from "./policy.js";

const { halfL, halfW } = PITCH;
const POST = PITCH.goalWidth / 2;
const MAX_OPTIONS = 14;

// ---------------------------------------------------------------- ball model
export const BALL = {
  g: 9.81,
  roll: 1.7, // m/s² rolling deceleration on grass
  airDrag: 0.035, // 1/s, linear
  restitution: 0.55,
  bounceGrip: 0.64, // horizontal speed kept per bounce
  radius: 0.11,
};

// Integrates a free ball in place. z is the height of the ball's underside (0 = resting on grass).
export function advanceBall(b, dt) {
  if (b.z > 0 || b.vz > 0) {
    const k = 1 - BALL.airDrag * dt;
    b.vx *= k;
    b.vy *= k;
    b.vz -= BALL.g * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.z <= 0) {
      b.z = 0;
      if (b.vz < -1.4) {
        b.vz = -b.vz * BALL.restitution;
        b.vx *= BALL.bounceGrip;
        b.vy *= BALL.bounceGrip;
      } else b.vz = 0;
    }
    return;
  }
  const s = Math.hypot(b.vx, b.vy);
  if (s < 1e-4) {
    b.vx = b.vy = 0;
    return;
  }
  const k = Math.max(0, s - BALL.roll * dt) / s;
  b.x += b.vx * dt * (1 + k) * 0.5;
  b.y += b.vy * dt * (1 + k) * 0.5;
  b.vx *= k;
  b.vy *= k;
}

const LOFT_ANGLE = { pass: 0.5, through: 0.62, cross: 0.42, clear: 0.62 };
// fraction of the distance covered in the air; the rest is bounce and roll
const LOFT_CARRY = { pass: 0.84, through: 0.76, cross: 1, clear: 1 };
const ARRIVE_SPEED = { pass: 9.5, through: 5.5, cross: 8, clear: 9 };

// Launch velocity so the ball reaches `target` at a sensible pace. Lofted kicks land a little
// short of the target and skip on, which is how a receiver actually wants a long ball.
export function planKick(kind, from, target, lofted = false) {
  const dx = target.x - from.x,
    dy = target.y - from.y,
    d = Math.max(0.5, Math.hypot(dx, dy));
  const ux = dx / d,
    uy = dy / d;
  if (!lofted) {
    // longer passes are struck firmer so defenders get less time to step across
    // and short ones are rolled softly enough to take in stride
    const va = kind === "pass" ? clamp(7.5 + d * 0.3, 8.5, 16) : (ARRIVE_SPEED[kind] ?? 8),
      v = Math.min(24, Math.sqrt(va * va + 2 * BALL.roll * d));
    return { vx: ux * v, vy: uy * v, vz: 0, speed: v, eta: (v - va) / BALL.roll, lofted: false };
  }
  const th = LOFT_ANGLE[kind] ?? 0.44,
    carry = d * (LOFT_CARRY[kind] ?? 0.85),
    v0 = Math.sqrt((carry * BALL.g) / Math.sin(2 * th)),
    tf = (2 * v0 * Math.sin(th)) / BALL.g,
    v = Math.min(31, v0 * (1 + BALL.airDrag * tf * 0.5));
  return {
    vx: ux * v * Math.cos(th),
    vy: uy * v * Math.cos(th),
    vz: v * Math.sin(th),
    speed: v,
    eta: tf * (kind === "cross" || kind === "clear" ? 1 : 1.12),
    lofted: true,
  };
}

// Shot aimed at a point in the goal mouth: solve vz so the ball is at height tz on arrival.
export function planShot(from, target, speed) {
  const dx = target.x - from.x,
    dy = target.y - from.y,
    d = Math.max(0.5, Math.hypot(dx, dy)),
    t = d / (speed * (1 - BALL.airDrag * (d / speed) * 0.5));
  return {
    vx: (dx / d) * speed,
    vy: (dy / d) * speed,
    vz: Math.max(0, ((target.z ?? 0.8) + 0.5 * BALL.g * t * t) / t),
    speed,
    eta: t,
  };
}

// Samples the un-errored trajectory for the arrow overlay.
export function kickPath(from, k, reach, n = 8) {
  const b = { x: from.x, y: from.y, z: from.z ?? 0, vx: k.vx, vy: k.vy, vz: k.vz },
    raw = [{ x: b.x, y: b.y, z: b.z }];
  for (let i = 0; i < 420; i++) {
    advanceBall(b, 1 / 60);
    raw.push({ x: b.x, y: b.y, z: b.z });
    if (Math.hypot(b.x - from.x, b.y - from.y) >= reach) break;
    if (!b.vx && !b.vy && !b.vz) break;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = raw[Math.round((i / (n - 1)) * (raw.length - 1))];
    out.push({ x: round(p.x, 2), y: round(p.y, 2), z: round(p.z, 2) });
  }
  return out;
}

export function linePath(a, b, n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1),
      e = t * (2 - t); // eased: samples bunch toward the destination like a decelerating run
    out.push({ x: round(lerp(a.x, b.x, e), 2), y: round(lerp(a.y, b.y, e), 2), z: 0 });
  }
  return out;
}

// ---------------------------------------------------------------- shared geometry
export function decisionKind(sim, p) {
  if (sim.restart) {
    if (sim.restart.takerId === p.id) return "restart";
    if (p.role === "GK") return "keeper";
    return sim.restart.team === p.team ? "attack" : "defend";
  }
  if (p.role === "GK") return "keeper";
  const owner = sim.owner();
  if (owner) return owner === p ? "carrier" : owner.team === p.team ? "attack" : "defend";
  const f = sim.ball.flight,
    to = f?.toId ? sim.player(f.toId) : null;
  if (to && f.kind !== "shot" && f.kind !== "clear") return to.team === p.team ? "attack" : "defend";
  return "loose";
}

export function goalOpeningDeg(p, dir) {
  const gx = dir * halfL,
    a1 = Math.atan2(POST - p.y, gx - p.x),
    a2 = Math.atan2(-POST - p.y, gx - p.x);
  return Math.abs(deg(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2))));
}

const inPitch = (p, m = 1.5) => ({
  x: clamp(p.x, -halfL + m, halfL - m),
  y: clamp(p.y, -halfW + m, halfW - m),
});
const nearestDist = (pt, list, skip) => {
  let best = 40;
  for (const o of list) if (o !== skip) best = Math.min(best, dist(pt, o));
  return best;
};
const tag = (p) => `${p.id} (${p.role})`;
const openness = (lane) => (lane >= 4 ? "open" : lane >= 2.2 ? "tight" : "risky");

function context(sim, me) {
  const dir = sim.attackDir(me.team),
    mates = [],
    opps = [];
  for (const p of sim.players) if (p !== me) (p.team === me.team ? mates : opps).push(p);
  const owner = sim.owner(),
    f = sim.ball.flight,
    receiver = !owner && f?.toId ? sim.player(f.toId) : null;
  const pressure = nearestDist(me, opps);
  return {
    sim, me, dir, mates, opps, owner, receiver, pressure,
    ball: sim.ball,
    focus: owner ?? receiver ?? sim.ball,
    N: (x) => x * dir,
    goal: { x: dir * halfL, y: 0 },
    ownGoal: { x: -dir * halfL, y: 0 },
    lineN: sim.offsideLineN(me.team),
  };
}

// "Progress" means up the pitch in build-up but *toward the goal* in the attacking third, so a
// cut-back from the byline counts as progress and a run into the corner flag does not.
function progressOf(c, from, to) {
  const w = smoothstep(10, 35, c.N(from.x));
  return lerp(c.N(to.x) - c.N(from.x), dist(from, c.goal) - dist(to, c.goal), w);
}

// Min opponent distance to the ball's path, weighted by where along it they stand: someone
// beside the kicker has no time to react, someone near the receiver has the whole flight.
function laneClear(c, a, b, lofted = false) {
  let best = 15;
  for (const o of c.opps) {
    const s = pointSegment(o, a, b);
    if (s.t <= 0.03 || (lofted && s.t < 0.75)) continue;
    const reach = o.role === "GK" && !lofted ? 0.75 : 1;
    best = Math.min(best, (s.d * reach) / (0.6 + 0.8 * s.t));
  }
  return best;
}

// Who gets to the planned ball first? Rolls the kick forward and races the receiver against every
// opponent with the same movement model the sim uses, so success_p reflects what will really happen.
const READ_DELAY = 0.5; // opponents only react once they have read the pass
function raceFor(c, k, mate) {
  const { sim } = c,
    b = { x: c.ball.x, y: c.ball.y, z: 0, vx: k.vx, vy: k.vy, vz: k.vz };
  let recvT = 9.9,
    oppT = 9.9;
  for (let i = 1; i <= 50 && (recvT > 9 || i * 0.1 < recvT + 1.3); i++) {
    for (let j = 0; j < 4; j++) advanceBall(b, 0.025);
    const t = i * 0.1;
    if (Math.abs(b.x) > halfL || Math.abs(b.y) > halfW) break;
    if (b.z > 2.3) continue;
    if (recvT > 9 && b.z <= 1.2 && sim.etaTo(mate, b) <= t - 0.1) recvT = t;
    if (oppT > 9)
      for (const o of c.opps) {
        const hands = o.role === "GK" && sim.inOwnArea(o, 1);
        // either he is already standing in the way, or he has time to read it and step across
        const reach = b.z <= (hands ? 2.3 : 1.2);
        if (reach && ((t >= 0.15 && dist(o, b) < 1.0) || sim.etaTo(o, b) + READ_DELAY <= t)) {
          oppT = t;
          break;
        }
      }
  }
  // a kick never lands exactly where it was aimed, so the longer the ball the more head start the
  // receiver needs before the race counts as won: risk is 0 (clear) … 1 (opponent favourite)
  const edge = clamp(oppT - recvT, -3, 3),
    need = 0.45 + dist(c.ball, b) * 0.022;
  return { recvT, oppT, edge, risk: recvT > 9 ? 1 : clamp((need - edge) / (need + 0.3), 0, 1) };
}

// ---------------------------------------------------------------- carrier options
function passCandidates(c, { restart = false } = {}) {
  const { me, sim } = c,
    out = [];
  for (const m of c.mates) {
    const margin = c.lineN - c.N(m.x);
    if (margin < 0 && sim.restart?.type !== "throw_in" && sim.restart?.type !== "goal_kick") continue;
    const d0 = dist(me, m);
    if (d0 < 4 || d0 > 62) continue;
    if (m.role === "GK" && (d0 < 9 || restart)) continue;
    // lead the receiver a touch so the ball arrives into their stride
    const lead = clamp(d0 / 18, 0.2, 1.1) * 0.55,
      target = inPitch({ x: m.x + m.vx * lead, y: m.y + m.vy * lead }, 1),
      d = dist(me, target),
      ground = laneClear(c, me, target, false),
      air = d > 15 ? laneClear(c, me, target, true) : 0,
      lofted = d > 30 || (d > 15 && ground < 2 && air > ground + 1.5),
      lane = lofted ? air : ground,
      space = nearestDist(target, c.opps),
      progress = progressOf(c, me, target),
      k = planKick("pass", me, target, lofted),
      race = raceFor(c, k, m);
    const success = clamp(
      0.96 - 0.003 * d - Math.max(0, 3 - lane) * 0.1 - Math.max(0, 3 - space) * 0.05 -
        race.risk * 0.6 -
        (lofted ? 0.08 + 0.002 * d : 0) - (c.pressure < 2 && !restart ? 0.07 : 0),
      0.05, 0.97,
    );
    out.push({
      id: `pass_${m.id}`, mate: m, target, d, lofted, lane, space, progress, success, k, race,
      score: success + 0.012 * clamp(progress, -20, 30) + 0.008 * Math.min(space, 10),
      margin,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function passOption(c, p) {
  const k = p.k;
  return {
    action: "pass",
    target_id: p.mate.id,
    target: p.target,
    label: `${p.lofted ? "Long pass" : "Pass"} to ${tag(p.mate)} · ${Math.round(p.d)} m · ${openness(p.lane)}`,
    features: {
      dist_m: p.d, progress_m: p.progress, lane_clear_m: p.lane, receiver_space_m: p.space,
      success_p: p.success, eta_s: p.race.recvT, opp_eta_s: p.race.oppT, offside_margin_m: Math.min(p.margin, 30), lofted: p.lofted,
    },
    path: kickPath(c.ball, k, p.d),
  };
}

function throughCandidates(c) {
  const { me, sim } = c,
    out = [];
  if (c.N(me.x) < -20) return out;
  for (const m of c.mates) {
    if (m.role === "GK" || m.role === "CB") continue;
    const margin = c.lineN - c.N(m.x);
    if (margin < 0 || c.N(m.x) < c.N(me.x) - 4) continue;
    const txN = Math.min(Math.max(c.N(m.x), c.lineN) + 9, halfL - 7);
    if (txN - c.N(m.x) < 5 || txN < 8) continue;
    const target = { x: txN * c.dir, y: clamp(m.y * 0.78, -halfW + 3, halfW - 3) },
      d = dist(me, target);
    if (d < 9 || d > 48) continue;
    const lofted = d > 30 || laneClear(c, me, target, false) < 1.6,
      lane = laneClear(c, me, target, lofted),
      k = planKick("through", me, target, lofted),
      race = raceFor(c, k, m),
      runEta = race.recvT,
      oppEta = race.oppT,
      success = clamp(
        0.92 - race.risk * 0.75 - Math.max(0, 3 - lane) * 0.06 - (lofted ? 0.1 : 0) - 0.004 * d,
        0.05, 0.9,
      );
    if (success < 0.3) continue;
    out.push({ mate: m, target, d, lofted, lane, k, runEta, oppEta, success, margin,
      progress: progressOf(c, me, target), space: nearestDist(target, c.opps) });
  }
  out.sort((a, b) => b.success - a.success);
  return out.slice(0, 2);
}

function shootOption(c) {
  const { me, goal } = c,
    d = dist(me, goal);
  if (d > 32) return null;
  const angle = goalOpeningDeg(me, c.dir);
  if (angle < 7) return null;
  const gk = c.opps.find((o) => o.role === "GK"),
    // aim inside the post on the side the keeper has left more open
    side = gk && gk.y > (me.y * 0.15) ? -1 : 1,
    target = { x: goal.x, y: side * (POST - 0.75), z: 0.9 };
  let blockers = 0;
  for (const o of c.opps) {
    if (o.role === "GK") continue;
    const s = pointSegment(o, me, target);
    if (s.t > 0.04 && s.t < 0.98 && s.d < 1.1 + s.t * 1.2) blockers++;
  }
  const keeperOff = gk ? pointSegment(gk, me, goal).d : 5,
    xg = clamp(
      0.75 * Math.exp(-d / 8.5) * Math.min(1, angle / 20) * 0.72 ** blockers *
        (c.pressure < 1.6 ? 0.75 : 1) * (1 + Math.min(keeperOff, 4) * 0.12),
      0.01, 0.95,
    ),
    k = planShot(c.ball, target, 27);
  return {
    action: "shoot",
    target_id: null,
    target: { x: target.x, y: target.y },
    label: `Shoot · ${Math.round(d)} m · xG ${xg.toFixed(2)}`,
    features: { dist_m: d, angle_deg: angle, blockers, xg, keeper_off_m: keeperOff, pressure_m: c.pressure },
    path: kickPath(c.ball, k, d, 6),
  };
}

function crossOption(c, force = false) {
  const { me } = c;
  if (!force && (c.N(me.x) < 30 || Math.abs(me.y) < 13)) return null;
  const inBox = c.mates.filter((m) => c.N(m.x) > halfL - 20 && Math.abs(m.y) < 14 && m.role !== "GK");
  // far-post area by default; otherwise the best-placed runner in the box
  let target = { x: c.dir * (halfL - 8.5), y: -Math.sign(me.y || 1) * 2.5 },
    mate = null,
    best = -1;
  for (const m of inBox) {
    const s = nearestDist(m, c.opps) - Math.abs(c.N(m.x) - (halfL - 9)) * 0.2;
    if (s > best) (best = s), (mate = m);
  }
  if (mate) target = inPitch({ x: mate.x + mate.vx * 0.6, y: mate.y + mate.vy * 0.6 }, 3);
  const d = dist(me, target);
  if (d < 12) return null;
  const space = nearestDist(target, c.opps),
    success = clamp(0.3 + inBox.length * 0.09 + Math.min(space, 5) * 0.05 - 0.004 * d, 0.05, 0.75),
    k = planKick("cross", me, target, true);
  return {
    action: "cross",
    target_id: mate?.id ?? null,
    target,
    label: `Cross${mate ? ` to ${tag(mate)}` : " far post"} · ${inBox.length} in box`,
    features: { dist_m: d, receiver_space_m: space, success_p: success, targets: inBox.length, eta_s: k.eta, lofted: true },
    path: kickPath(c.ball, k, d),
  };
}

const DRIBBLES = { fwd: [1, 0], left: [0.55, -1], right: [0.55, 1], back: [-1, 0] };

function dribbleOption(c, name) {
  const { me, dir } = c,
    [fx, fy] = DRIBBLES[name],
    l = Math.hypot(fx, fy),
    // "forward" bends toward the goal in the attacking third, so wide carriers cut inside instead of running to the byline
    w = smoothstep(12, 34, c.N(me.x)) * 0.85,
    gd = dist(me, c.goal) || 1,
    bx = lerp(dir, (c.goal.x - me.x) / gd, w),
    by = lerp(0, (c.goal.y - me.y) / gd, w),
    bl = Math.hypot(bx, by) || 1,
    ex = bx / bl,
    ey = by / bl,
    // local (forward, right) frame onto that heading; right of heading e is (−ey, ex)
    ux = (fx / l) * ex - (fy / l) * ey,
    uy = (fx / l) * ey + (fy / l) * ex,
    target = inPitch({ x: me.x + ux * 7, y: me.y + uy * 7 }, 2);
  if (dist(me, target) < 3.5) return null;
  // open grass ends at the touchline: running room is capped by the pitch edge in that direction
  let space = Math.min(
    15,
    ux ? ((ux > 0 ? halfL : -halfL) - me.x) / ux : 15,
    uy ? ((uy > 0 ? halfW : -halfW) - me.y) / uy : 15,
  );
  for (const o of c.opps) {
    const ox = o.x - me.x,
      oy = o.y - me.y,
      d = Math.hypot(ox, oy);
    if (d < 15 && (ox * ux + oy * uy) / (d || 1) > 0.78) space = Math.min(space, d);
  }
  const pressureAfter = nearestDist(target, c.opps),
    progress = progressOf(c, me, target);
  return {
    action: "dribble",
    target_id: null,
    target,
    label: `Dribble ${name === "fwd" ? "forward" : name} · ${Math.round(space)} m space`,
    features: { space_m: space, progress_m: progress, pressure_m: pressureAfter },
    path: linePath(me, target),
  };
}

function clearOption(c) {
  const { me, dir } = c,
    side = Math.sign(me.y || 1),
    target = inPitch({ x: me.x + dir * 42, y: clamp(me.y + side * 12, -halfW + 5, halfW - 5) }, 4),
    d = dist(me, target),
    k = planKick("clear", me, target, true);
  return {
    action: "clear",
    target_id: null,
    target,
    label: `Clear upfield · ${Math.round(d)} m`,
    features: { dist_m: d, pressure_m: c.pressure, progress_m: c.N(target.x) - c.N(me.x), lofted: true },
    path: kickPath(c.ball, k, d),
  };
}

function holdOption(c, heldS) {
  return {
    action: "hold",
    target_id: null,
    target: { x: c.me.x, y: c.me.y },
    label: `Hold the ball · pressure ${c.pressure.toFixed(1)} m`,
    features: { pressure_m: c.pressure, held_s: heldS },
    path: linePath(c.me, c.me, 2),
  };
}

function carrierOptions(c, add, { keeper = false } = {}) {
  const { me, sim } = c,
    heldS = sim.time - (me.possessedAt ?? sim.time),
    extras = [];
  const shot = keeper ? null : shootOption(c);
  if (shot) extras.push(["shoot", shot]);
  const cross = keeper ? null : crossOption(c);
  if (cross) extras.push(["cross", cross]);
  const throughs = keeper ? [] : throughCandidates(c);
  const dribbles = keeper ? [] : Object.keys(DRIBBLES).map((n) => [`dribble_${n}`, dribbleOption(c, n)]).filter((e) => e[1]);
  const wantClear = keeper || (c.N(me.x) < -17 && c.pressure < 6);
  const fixed = extras.length + throughs.length + dribbles.length + (wantClear ? 1 : 0) + 1;
  const passes = passCandidates(c).slice(0, Math.min(6, MAX_OPTIONS - fixed));
  for (const [id, o] of extras) add(id, o);
  for (const p of passes) add(p.id, passOption(c, p));
  for (const t of throughs)
    add(`through_${t.mate.id}`, {
      action: "through",
      target_id: t.mate.id,
      target: t.target,
      label: `Through ball for ${tag(t.mate)} · ${Math.round(t.d)} m · ${openness(t.lane)}`,
      features: {
        dist_m: t.d, progress_m: t.progress, lane_clear_m: t.lane, receiver_space_m: t.space, success_p: t.success,
        eta_s: t.runEta, opp_eta_s: t.oppEta, offside_margin_m: Math.min(t.margin, 30), lofted: t.lofted,
      },
      path: kickPath(c.ball, t.k, t.d),
    });
  for (const [id, o] of dribbles) add(id, o);
  if (wantClear) add("clear", clearOption(c));
  add("hold", holdOption(c, heldS));
}

function restartOptions(c, add) {
  const type = c.sim.restart?.type;
  if (type === "corner") add("cross", crossOption(c, true));
  let passes = passCandidates(c, { restart: true });
  if (type === "throw_in") passes = passes.filter((p) => p.d < 32);
  if (type === "kickoff") passes = passes.filter((p) => p.d < 30);
  for (const p of passes.slice(0, 6)) add(p.id, passOption(c, p));
  if (!passes.length && type !== "corner") add("clear", clearOption(c));
}

// ---------------------------------------------------------------- off-the-ball options
function moveOption(c, action, target, label, extra = {}) {
  const { me, focus } = c;
  return {
    action,
    target_id: null,
    target,
    label,
    features: {
      space_m: nearestDist(target, c.opps),
      lane_clear_m: laneClear(c, focus, target),
      progress_m: c.N(target.x) - c.N(c.ball.x),
      dist_m: dist(me, target),
      ...extra,
    },
    path: linePath(me, target),
  };
}

const clampOnside = (c, p) => ({ x: Math.min(c.N(p.x), c.lineN - 0.4) * c.dir, y: p.y });

function shapeOption(c) {
  const a = c.sim.anchor(c.me);
  return moveOption(c, "shape", a, `Hold ${c.me.role} shape · ${Math.round(dist(c.me, a))} m`);
}

function supportNear(c) {
  const { me, focus, dir, sim } = c,
    anchor = sim.anchor(me);
  let best = null,
    bestScore = -Infinity;
  for (const r of [9, 15])
    for (const a of [-2.2, -1.3, -0.5, 0.5, 1.3, 2.2]) {
      const p = clampOnside(c, inPitch({ x: focus.x + Math.cos(a) * r * dir, y: focus.y + Math.sin(a) * r }, 3)),
        lane = Math.min(laneClear(c, focus, p), 6),
        space = Math.min(nearestDist(p, c.opps), 8),
        crowd = nearestDist(p, c.mates, c.owner ?? c.receiver),
        score = lane * 0.5 + space * 0.4 - dist(me, p) * 0.16 - dist(p, anchor) * 0.06 +
          (c.N(p.x) - c.N(focus.x)) * 0.04 - (crowd < 6 ? (6 - crowd) * 0.5 : 0);
      if (score > bestScore) (bestScore = score), (best = p);
    }
  return moveOption(c, "support", best, `Show for the ball · ${Math.round(dist(best, focus))} m from carrier`);
}

function supportWide(c) {
  const { me, focus, dir, sim } = c,
    a = sim.anchor(me),
    side = Math.sign(a.y || me.y || 1),
    p = clampOnside(c, inPitch({ x: Math.max(c.N(focus.x) + 5, c.N(a.x)) * dir, y: side * (halfW - 4.5) }, 3));
  return moveOption(c, "support", p, `Offer width ${side * dir > 0 ? "right" : "left"} · ${Math.round(dist(me, p))} m`);
}

function runBehind(c) {
  const { me, dir, sim } = c,
    a = sim.anchor(me),
    txN = Math.min(c.lineN + 10, halfL - 7),
    p = { x: txN * dir, y: clamp(me.y * 0.6 + a.y * 0.4, -halfW + 6, halfW - 6) },
    margin = c.lineN - c.N(me.x);
  return moveOption(c, "run", p, `Run in behind · ${Math.round(txN - c.N(me.x))} m ahead`, {
    offside_margin_m: clamp(margin, -30, 30),
  });
}

function attackOptions(c, add) {
  add("shape", shapeOption(c));
  add("support_near", supportNear(c));
  add("support_wide", supportWide(c));
  if (c.lineN - c.N(c.me.x) > -1 && c.N(c.ball.x) > -30) add("run_behind", runBehind(c));
}

function dangerOf(c, o) {
  return clamp(1.15 - dist(o, c.ownGoal) / 55, 0, 1);
}

function pressOption(c) {
  const { me, sim, focus } = c,
    target = "vx" in focus && focus !== c.ball ? { x: focus.x + focus.vx * 0.35, y: focus.y + focus.vy * 0.35 } : { x: focus.x, y: focus.y },
    eta = sim.etaTo(me, target);
  let rank = 1;
  for (const m of c.mates) if (m.role !== "GK" && sim.etaTo(m, target) < eta) rank++;
  const who = focus.id ?? "ball";
  return {
    action: "press",
    target_id: focus.id ?? null,
    target,
    label: `Press ${who} · ${eta.toFixed(1)} s away${rank === 1 ? " · closest" : ""}`,
    features: { eta_s: eta, rank, dist_m: dist(me, target), danger: dangerOf(c, focus) },
    path: linePath(me, target),
  };
}

export function markSpot(c_ownGoal, o, ball) {
  const gx = c_ownGoal.x - o.x,
    gy = c_ownGoal.y - o.y,
    gl = Math.hypot(gx, gy) || 1,
    bx = ball.x - o.x,
    by = ball.y - o.y,
    bl = Math.hypot(bx, by) || 1;
  // goal-side, shaded slightly toward the ball so the passing lane is contested too
  return { x: o.x + (gx / gl) * 1.6 + (bx / bl) * 0.5, y: o.y + (gy / gl) * 1.6 + (by / bl) * 0.5 };
}

function markOptions(c, add) {
  const { me } = c,
    list = [];
  for (const o of c.opps) {
    if (o.role === "GK" || o === c.owner) continue;
    const d = dist(me, o);
    if (d > 22) continue;
    const danger = dangerOf(c, o),
      cover = nearestDist(o, c.mates.filter((m) => m.role !== "GK"));
    list.push({ o, d, danger, cover, score: danger * 1.2 - d * 0.035 + Math.min(cover, 8) * 0.04 });
  }
  list.sort((a, b) => b.score - a.score);
  for (const m of list.slice(0, 2)) {
    const spot = inPitch(markSpot(c.ownGoal, m.o, c.ball), 1);
    add(`mark_${m.o.id}`, {
      action: "mark",
      target_id: m.o.id,
      target: spot,
      label: `Mark ${tag(m.o)} · ${Math.round(m.d)} m · ${m.cover < 3 ? "covered" : "free"}`,
      features: { dist_m: dist(me, spot), danger: m.danger, space_m: m.cover },
      path: linePath(me, spot),
    });
  }
}

export function coverSpot(sim, p) {
  const dir = sim.attackDir(p.team),
    own = { x: -dir * halfL, y: 0 },
    b = sim.ball,
    a = sim.anchor(p),
    t = 0.38;
  return inPitch({ x: lerp(b.x, own.x, t), y: lerp(lerp(b.y, own.y, t), a.y, 0.45) }, 2);
}

function coverOption(c) {
  const { me, sim } = c,
    spot = coverSpot(sim, me),
    d = dist(me, spot);
  let rank = 1;
  for (const m of c.mates) if (m.role !== "GK" && dist(m, spot) < d) rank++;
  return {
    action: "cover",
    target_id: null,
    target: spot,
    label: `Drop and cover · ${Math.round(d)} m`,
    features: { dist_m: d, danger: dangerOf(c, c.ball), rank },
    path: linePath(me, spot),
  };
}

function chaseOption(c) {
  const { me, sim } = c,
    hit = sim.interceptFor(me);
  let oppEta = 9.9,
    mateEta = 9.9;
  for (const o of c.opps) oppEta = Math.min(oppEta, sim.interceptFor(o).eta);
  for (const m of c.mates) mateEta = Math.min(mateEta, sim.interceptFor(m).eta);
  return {
    action: "chase",
    target_id: null,
    target: { x: hit.x, y: hit.y },
    label: `Chase the ball · ${hit.eta.toFixed(1)} s (opp ${oppEta.toFixed(1)} s)`,
    features: { eta_s: hit.eta, opp_eta_s: oppEta, mate_eta_s: mateEta, dist_m: dist(me, hit) },
    path: linePath(me, hit),
  };
}

function defendOptions(c, add) {
  const { sim, me } = c;
  if (!sim.restart) add("press", pressOption(c));
  markOptions(c, add);
  add("cover", coverOption(c));
  add("shape", shapeOption(c));
  // a pass in flight can be cut out — only offered when this player would actually get there first
  if (!c.owner && c.receiver) {
    const mine = sim.interceptFor(me).eta,
      theirs = sim.interceptFor(c.receiver).eta;
    if (mine < theirs - 0.2 && mine < 3) add("chase", chaseOption(c));
  }
}

function looseOptions(c, add) {
  add("chase", chaseOption(c));
  add("shape", shapeOption(c));
  add("cover", coverOption(c));
  if (c.sim.possession === c.me.team) add("support_near", supportNear(c));
}

// ---------------------------------------------------------------- keeper
export function keeperSetSpot(sim, gk) {
  const dir = sim.attackDir(gk.team),
    own = { x: -dir * halfL, y: 0 },
    b = sim.ball,
    d = dist(b, own),
    ux = (b.x - own.x) / (d || 1),
    uy = (b.y - own.y) / (d || 1),
    // off the line as the ball moves away; sweeper position when own team has it upfield
    out = clamp(1.2 + (d - 8) * 0.11, 1.2, sim.possession === gk.team ? 16 : 9);
  return { x: clamp(own.x + ux * out, -halfL + 0.6, halfL - 0.6), y: clamp(own.y + uy * out, -6, 6) };
}

function keeperOptions(c, add) {
  const { me, sim, ball, ownGoal } = c,
    set = keeperSetSpot(sim, me);
  add("gk_set", {
    action: "gk_set",
    target_id: null,
    target: set,
    label: `Set position · ${dist(set, ownGoal).toFixed(1)} m off the line`,
    features: { dist_m: dist(me, set), danger: dangerOf(c, ball) },
    path: linePath(me, set),
  });
  if (sim.restart || c.owner) return;
  const f = ball.flight,
    hostile = !f || f.kind !== "shot",
    hit = sim.interceptFor(me),
    inReach = dist(hit, ownGoal) < 24 && Math.abs(hit.y) < 22;
  if (!hostile || !inReach) return;
  let oppEta = 9.9;
  for (const o of c.opps) oppEta = Math.min(oppEta, sim.interceptFor(o).eta);
  const high = ball.z > 1.4 || ball.vz > 3 || f?.kind === "cross";
  if (high && dist(hit, ownGoal) < 13) {
    add("gk_claim", {
      action: "gk_claim",
      target_id: null,
      target: { x: hit.x, y: hit.y },
      label: `Claim the high ball · ${hit.eta.toFixed(1)} s (opp ${oppEta.toFixed(1)} s)`,
      features: { eta_s: hit.eta, opp_eta_s: oppEta, dist_m: dist(me, hit), height_m: ball.z },
      path: linePath(me, hit),
    });
  } else if (!f || f.kind === "through" || f.kind === "clear" || !f.toId || f.kind === "pass") {
    add("gk_rush", {
      action: "gk_rush",
      target_id: null,
      target: { x: hit.x, y: hit.y },
      label: `Rush out · ${hit.eta.toFixed(1)} s (opp ${oppEta.toFixed(1)} s)`,
      features: { eta_s: hit.eta, opp_eta_s: oppEta, dist_m: dist(me, hit) },
      path: linePath(me, hit),
    });
  }
}

// ---------------------------------------------------------------- assembly
function tidy(o) {
  const features = {};
  for (const [k, v] of Object.entries(o.features)) {
    if (typeof v === "boolean") features[k] = v;
    else features[k] = Number.isFinite(v) ? round(v, k.endsWith("_p") || k === "xg" || k === "danger" ? 2 : 1) : 0;
  }
  let path = o.path;
  if (!path || path.length < 2) path = [{ x: round(o.target.x, 2), y: round(o.target.y, 2), z: 0 }, { x: round(o.target.x, 2), y: round(o.target.y, 2), z: 0 }];
  return {
    action: o.action,
    target_id: o.target_id ?? null,
    target: { x: round(o.target.x, 2), y: round(o.target.y, 2) },
    label: o.label,
    features,
    path,
  };
}

export function buildDecisionState(sim, player) {
  const c = context(sim, player),
    kind = decisionKind(sim, player),
    options = {},
    add = (id, o) => {
      if (o && Object.keys(options).length < MAX_OPTIONS) options[id] = tidy(o);
    };
  const hasBall = sim.ball.ownerId === player.id;
  if (kind === "restart") restartOptions(c, add);
  else if (kind === "keeper") hasBall ? carrierOptions(c, add, { keeper: sim.keeperProtected(player) }) : keeperOptions(c, add);
  else if (kind === "carrier") carrierOptions(c, add);
  else if (kind === "attack") attackOptions(c, add);
  else if (kind === "defend") defendOptions(c, add);
  else looseOptions(c, add);
  if (!Object.keys(options).length) add("hold", holdOption(c, 0));

  const state = {
    batch_id: sim.nextBatchId(),
    player_id: player.id,
    team: TEAMS[player.team].id,
    role: player.role,
    number: player.number,
    kind,
    self: {
      x: round(c.N(player.x), 1),
      y: round(c.N(player.y), 1),
      speed: round(player.speed, 1),
      has_ball: hasBall,
      pressure_m: round(c.pressure, 1),
      goal_dist_m: round(dist(player, c.goal), 1),
      goal_angle_deg: round(goalOpeningDeg(player, c.dir), 1),
      nearest_teammate_m: round(nearestDist(player, c.mates), 1),
      held_s: round(hasBall ? sim.time - (player.possessedAt ?? sim.time) : 0, 1),
      wide_role: WIDE_ROLES.has(player.role),
      prev_choice: player.decision?.choice ?? null,
    },
    options,
  };
  state.local = localPolicy(state);
  return state;
}
