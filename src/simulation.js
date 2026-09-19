// JevBall match simulation: physics, rules, possession, restarts and human control.
// Pure JS, no DOM, deterministic from the seed and the sequence of calls.
//
// Driver loop used by everyone (browser, tests, headless script):
//
//   sim.step(1 / 60);
//   for (const p of sim.decisionDue()) sim.decideLocally(p); // or send to Jev via DecisionLoop
//
// The sim never decides *for* a player unless a decision is overdue (see `watchdog`), except for
// reflexes that are always local: meeting a pass, keeper saves, restart choreography.
import { PITCH, TEAMS, FORMATIONS, ROLE_SPEED } from "./pitch.js";
import {
  clamp, lerp, round, dist, mulberry32, rngNormal, rngRange, angleDiff, turnToward,
} from "./math.js";
import {
  BALL, advanceBall, planKick, planShot, buildDecisionState, decisionKind,
  markSpot, coverSpot, keeperSetSpot,
} from "./candidates.js";
import { localPolicy, utilities } from "./policy.js";

const { halfL, halfW } = PITCH;
const POST = PITCH.goalWidth / 2;
const ACCEL = 12;
const CONTROL_R = 0.9;
const CONTROL_Z = 1.2;
const TACKLE_R = 1.3;
const RESTART_KEEP = PITCH.centerCircle;
const RESTART_AUTO_S = 6;
const KEEPER_HOLD_S = 5;
const KICK_ACTIONS = new Set(["pass", "through", "cross", "shoot", "clear"]);
const CHASERS = new Set(["chase", "gk_rush", "gk_claim"]);

const ruleIntent = (type, label, extra = {}) => ({ type, target: null, targetId: null, label, ...extra });

export class Simulation {
  constructor(seed = 1, { formations = ["4-4-2", "4-3-3"], halfSeconds = 180 } = {}) {
    this.seed = seed;
    this.formations = formations.map((f) => (FORMATIONS[f] ? f : "4-4-2"));
    this.r = mulberry32(Number(seed) * 2654435761 + 97);
    this.policyRng = mulberry32(Number(seed) * 40503 + 7331);
    this.time = 0;
    this.paused = false;
    this.clock = { half: 1, elapsed: 0, halfSeconds, minute: 0 };
    this.phase = "kickoff";
    this.phaseT = 0;
    this.restart = null;
    this.score = [0, 0];
    this.possession = null;
    this.stats = {
      possessionTime: [0, 0], shots: [0, 0], onTarget: [0, 0], passes: [0, 0],
      passesCompleted: [0, 0], tackles: [0, 0], saves: [0, 0], corners: [0, 0],
    };
    this.events = [];
    this.human = null;
    this.humanInput = { mx: 0, my: 0, sprint: false, pass: false, shoot: false };
    this.ball = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0,
      ownerId: null, lastTouchId: null, lastTouchTeam: null, flight: null,
    };
    this.batchSeq = 0;
    this.decisionsMade = 0;
    this.rev = 0; // bumps whenever cached ball forecasts go stale
    this.passLive = null;
    this.shotLive = null;
    this.players = [];
    this.byId = new Map();
    this.createPlayers();
    this.setupKickoff(0, true);
  }

  createPlayers() {
    const r = mulberry32(Number(this.seed) * 7919 + 13);
    TEAMS.forEach((t, team) => {
      for (const s of FORMATIONS[this.formations[team]]) {
        const vary = () => 0.9 + r() * 0.2,
          pace = 0.95 + r() * 0.1;
        const p = {
          id: `${t.prefix}${s.number}`, team, number: s.number, role: s.role,
          x: 0, y: 0, vx: 0, vy: 0, facing: 0, speed: 0,
          maxSpeed: round(Math.min(8.2, ROLE_SPEED[s.role] * pace), 2),
          home: { ax: s.ax, ay: s.ay },
          attrs: { pace: round(pace, 3), passing: round(vary(), 3), shooting: round(vary(), 3), control: round(vary(), 3), tackling: round(vary(), 3), keeping: round(vary(), 3) },
          intent: ruleIntent("shape", "Kickoff position"),
          decision: null, lastDecisionState: null,
          nextDecisionAt: 0, pending: false, cooldown: 0, kickT: -10, possessedAt: 0, reflexUntil: 0,
          isHuman: false,
        };
        this.players.push(p);
        this.byId.set(p.id, p);
      }
    });
  }

  // ------------------------------------------------------------------ queries
  attackDir(team) {
    return (team === 0 ? 1 : -1) * (this.clock.half === 1 ? 1 : -1);
  }
  player(id) {
    return this.byId.get(id) ?? null;
  }
  teamPlayers(team) {
    return this.players.filter((p) => p.team === team);
  }
  owner() {
    return this.ball.ownerId ? this.byId.get(this.ball.ownerId) : null;
  }
  nextBatchId() {
    return `b${++this.batchSeq}`;
  }
  inOwnArea(p, margin = 0) {
    const dir = this.attackDir(p.team);
    return p.x * dir < -halfL + PITCH.penaltyAreaDepth + margin && Math.abs(p.y) < PITCH.penaltyAreaWidth / 2 + margin;
  }
  keeperProtected(p) {
    return !!p && p.role === "GK" && this.ball.ownerId === p.id && this.inOwnArea(p, 0.5);
  }

  // Offside line for `team` in its own attack-normalized x: second-last opponent, the ball, or halfway.
  offsideLineN(team) {
    const dir = this.attackDir(team);
    let a = -Infinity,
      b = -Infinity;
    for (const o of this.players) {
      if (o.team === team) continue;
      const x = o.x * dir;
      if (x > a) (b = a), (a = x);
      else if (x > b) b = x;
    }
    return Math.max(0, this.ball.x * dir, b);
  }

  // Dynamic formation slot: the block slides with the ball, squeezes when defending, stretches when attacking.
  anchor(p) {
    if (p.role === "GK") return keeperSetSpot(this, p);
    const dir = this.attackDir(p.team),
      has = this.possession === p.team,
      bN = clamp(this.ball.x * dir, -halfL, halfL),
      byN = clamp(this.ball.y * dir, -halfW, halfW);
    let xN = p.home.ax * halfL * 0.62 + bN * 0.56 + (has ? 12 : -5);
    xN = Math.max(xN, clamp(bN - 4, -47, -38)); // the back line never collapses onto its own keeper
    xN = Math.min(xN, halfL - 8);
    if (has) xN = Math.min(xN, this.offsideLineN(p.team) - 0.8);
    const yN = clamp(p.home.ay * halfW * (has ? 0.92 : 0.7) + byN * (has ? 0.16 : 0.3), -halfW + 2, halfW - 2);
    return { x: xN * dir, y: yN * dir };
  }

  kickoffSpot(p) {
    const dir = this.attackDir(p.team),
      r = this.restart;
    if (r?.takerId === p.id) return { x: -0.7 * dir, y: 0 };
    if (p.role === "GK") return { x: (-halfL + 2) * dir, y: 0 };
    let xN = -3 - (1 - p.home.ax) * 0.5 * halfL * 0.72;
    const y = p.home.ay * halfW * 0.85 * dir;
    if (Math.abs(y) < 10.5 && (!r || r.team !== p.team)) xN = Math.min(xN, -Math.sqrt(10.5 * 10.5 - y * y) - 0.5);
    return { x: xN * dir, y };
  }

  // Time for `p` to get to a point: reaction + run, plus what it costs to kill momentum that is
  // carrying him the wrong way (without this, players sprint past balls they "could" reach).
  etaTo(p, pt) {
    const dx = pt.x - p.x,
      dy = pt.y - p.y,
      d = Math.hypot(dx, dy);
    if (d < 0.3) return 0.05 + p.cooldown * 0.6;
    const top = Math.min(p.maxSpeed, 2 + d * 4),
      turn = Math.hypot((dx / d) * top - p.vx, (dy / d) * top - p.vy) / ACCEL;
    return Math.min(9.9, 0.1 + p.cooldown * 0.6 + d / (p.maxSpeed * 0.94) + turn * 0.45);
  }

  // Where the free ball will be over the next few seconds (cached until the world changes).
  forecast() {
    if (this._fc?.rev === this.rev) return this._fc.samples;
    const b = { ...this.ball },
      samples = [{ x: b.x, y: b.y, z: b.z, t: 0 }];
    if (!this.ball.ownerId)
      for (let i = 1; i <= 100; i++) {
        advanceBall(b, 0.025);
        advanceBall(b, 0.025);
        if (Math.abs(b.x) > halfL || Math.abs(b.y) > halfW) break;
        samples.push({ x: b.x, y: b.y, z: b.z, t: i * 0.05 });
        if (!b.vx && !b.vy && !b.vz) break;
      }
    this._fc = { rev: this.rev, samples, hits: new Map() };
    return samples;
  }

  // Earliest point where `p` can meet the ball: { x, y, eta }.
  interceptFor(p, slack = 0) {
    const samples = this.forecast(),
      hits = this._fc.hits,
      key = slack ? `${p.id}+${slack}` : p.id;
    if (hits.has(key)) return hits.get(key);
    const o = this.owner();
    let hit = null;
    if (o) {
      const pt = { x: o.x + o.vx * 0.35, y: o.y + o.vy * 0.35 };
      hit = { ...pt, eta: this.etaTo(p, pt) };
    } else {
      // `slack` asks for a meeting point he reaches with time to spare: aiming for the earliest
      // just-reachable point means any small error lets the ball fizz past
      const reachZ = p.role === "GK" && this.inOwnArea(p, 2) ? 2.2 : CONTROL_Z;
      let best = null,
        bestMargin = -Infinity;
      for (const s of samples) {
        if (s.z > reachZ) continue;
        const eta = this.etaTo(p, s),
          margin = s.t - eta;
        if (margin >= slack - 0.04) {
          hit = { x: s.x, y: s.y, eta: Math.max(s.t, eta) };
          break;
        }
        if (margin > bestMargin) (bestMargin = margin), (best = { x: s.x, y: s.y, eta: Math.max(s.t, eta) });
      }
      if (!hit) {
        // cannot get there in time anywhere: go where he loses the race by the least, or to where it will stop
        const last = samples.at(-1);
        hit = best && bestMargin > -0.6 ? best : { x: last.x, y: last.y, eta: Math.min(9.9, this.etaTo(p, last)) };
      }
    }
    hits.set(key, hit);
    return hit;
  }

  // ------------------------------------------------------------------ decisions
  decisionDue() {
    if (this.paused || !["play", "restart", "kickoff"].includes(this.phase)) return [];
    const r = this.restart,
      b = this.ball,
      out = [];
    for (const p of this.players) {
      if (p.isHuman || p.pending || this.time < p.nextDecisionAt || p.reflexUntil > this.time) continue;
      if (r) {
        if (p.id === r.takerId ? !r.ready : this.phase === "kickoff") continue;
      } else if (!b.ownerId && b.flight?.toId === p.id) continue; // meeting a pass is a reflex
      out.push(p);
    }
    const key = (p) => (b.ownerId === p.id ? -1 : dist(p, b));
    return out.sort((a, c) => key(a) - key(c));
  }

  decisionState(player) {
    return (player.lastDecisionState = buildDecisionState(this, player));
  }

  cadence(p) {
    const base = this.ball.ownerId === p.id ? 0.3 : dist(p, this.ball) < 15 ? 0.55 : 1.2;
    return base * (0.92 + this.r() * 0.16);
  }

  applyDecision(playerId, batchId, choice, meta = {}) {
    const p = this.player(playerId),
      st = p?.lastDecisionState,
      opt = st?.options[choice];
    if (!opt || st.batch_id !== batchId || st.applied || p.isHuman) return false;
    if (!["play", "restart", "kickoff"].includes(this.phase)) return false;
    const hasBall = this.ball.ownerId === p.id;
    if (decisionKind(this, p) !== st.kind || hasBall !== st.self.has_ball) return false;
    if (KICK_ACTIONS.has(opt.action)) {
      if (!hasBall) return false;
      // a late answer must not turn into an offside pass
      const mate = opt.target_id && this.player(opt.target_id);
      if (mate && !this.restart && this.offsideLineN(p.team) - mate.x * this.attackDir(p.team) < -0.6) return false;
    }
    st.applied = true;
    const probabilities = meta.probabilities ?? st.local.probabilities;
    p.decision = {
      batchId, kind: st.kind, choice, label: opt.label, source: meta.source ?? "local", probabilities,
      confidence: meta.confidence ?? probabilities[choice] ?? 1, at: this.time, options: st.options,
      latencyMs: meta.latencyMs ?? 0,
    };
    this.decisionsMade++;
    if (KICK_ACTIONS.has(opt.action)) {
      this.kick(p, opt);
      p.intent = ruleIntent("shape", opt.label);
      p.nextDecisionAt = this.time + 0.45;
      return true;
    }
    p.intent = { type: opt.action, target: { ...opt.target }, targetId: opt.target_id, label: opt.label };
    p.nextDecisionAt = this.time + this.cadence(p);
    return true;
  }

  decideLocally(player) {
    const st = this.decisionState(player),
      verdict = localPolicy(st, this.policyRng);
    return this.applyDecision(player.id, st.batch_id, verdict.choice, { source: "local", probabilities: verdict.probabilities });
  }

  // Anti-stall: make the ball holder do *something* with it, never `hold` or another dribble.
  forceRelease(p) {
    const st = this.decisionState(p),
      u = utilities(st);
    let best = null;
    for (const [id, o] of Object.entries(st.options))
      if (KICK_ACTIONS.has(o.action) && (best === null || u[id] > u[best])) best = id;
    if (best) return this.applyDecision(p.id, st.batch_id, best, { source: "rule", probabilities: { [best]: 1 } });
    // nobody to aim at: hoof it toward the opponent half
    const dir = this.attackDir(p.team);
    this.kick(p, { action: "clear", target_id: null, target: { x: clamp(p.x + dir * 35, -halfL + 5, halfL - 5), y: p.y * 0.6 }, features: { lofted: true } });
    return true;
  }

  pullDecisions(radius = Infinity) {
    const b = this.ball,
      list = this.players.filter((p) => dist(p, b) <= radius).sort((a, c) => dist(a, b) - dist(c, b));
    list.forEach((p, i) => (p.nextDecisionAt = Math.min(p.nextDecisionAt, this.time + 0.04 + i * 0.025)));
  }

  watchdog() {
    if (!["play", "restart"].includes(this.phase)) return;
    const o = this.owner();
    for (const p of this.decisionDueCandidates()) {
      const late = this.time - p.nextDecisionAt;
      if (late > (p.pending ? (p === o ? 0.45 : 0.9) : 1.6)) this.decideLocally(p);
    }
    if (o && !o.isHuman && !this.restart) {
      const held = this.time - o.possessedAt;
      if (this.keeperProtected(o) ? held > KEEPER_HOLD_S : held > 10) this.forceRelease(o);
    }
  }
  decisionDueCandidates() {
    const r = this.restart,
      b = this.ball;
    return this.players.filter(
      (p) => !p.isHuman && this.time >= p.nextDecisionAt && p.reflexUntil <= this.time &&
        (r ? (p.id === r.takerId ? r.ready : this.phase !== "kickoff") : b.ownerId || b.flight?.toId !== p.id),
    );
  }

  // ------------------------------------------------------------------ events
  event(type, team, playerId, text) {
    this.events.push({ t: round(this.time, 2), minute: this.clock.minute, type, team, playerId, text });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  // ------------------------------------------------------------------ match flow
  setupKickoff(team, teleport) {
    const taker = this.players
      .filter((p) => p.team === team && p.role !== "GK" && !p.isHuman)
      .sort((a, b) => b.home.ax - a.home.ax || a.number - b.number)[0];
    this.phase = "kickoff";
    this.phaseT = 0;
    this.restart = { type: "kickoff", team, x: 0, y: 0, takerId: taker.id, elapsed: 0, placed: true, ready: false, minWait: 1.2 };
    Object.assign(this.ball, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ownerId: null, flight: null });
    this.passLive = this.shotLive = null;
    this.possession = team;
    this.rev++;
    for (const p of this.players) {
      p.intent = ruleIntent("shape", "Kickoff position");
      p.cooldown = 0;
      p.reflexUntil = 0;
      if (teleport) {
        const s = this.kickoffSpot(p);
        Object.assign(p, { x: s.x, y: s.y, vx: 0, vy: 0, speed: 0, facing: this.attackDir(p.team) > 0 ? 0 : Math.PI });
      }
    }
  }

  startRestart(type, team, x, y) {
    const spot = { x, y },
      pool = this.players.filter((p) => p.team === team && !p.isHuman),
      outfield = pool.filter((p) => p.role !== "GK");
    let taker;
    if (type === "goal_kick") taker = pool.find((p) => p.role === "GK") ?? pool[0];
    else {
      const pick = type === "corner" ? outfield.filter((p) => p.role !== "CB" && p.role !== "ST") : outfield;
      taker = (pick.length ? pick : outfield).sort((a, b) => dist(a, spot) - dist(b, spot))[0];
    }
    this.phase = "restart";
    this.restart = { type, team, x, y, takerId: taker.id, elapsed: 0, placed: false, ready: false, minWait: 1.3 };
    this.ball.ownerId = null;
    this.ball.flight = null;
    this.passLive = this.shotLive = null;
    this.possession = team;
    if (type === "corner") this.stats.corners[team]++;
    const label = { throw_in: "Throw-in", corner: "Corner", goal_kick: "Goal kick", free_kick: "Free kick" }[type];
    this.event(type, team, taker.id, `${label} · ${TEAMS[team].short}`);
    for (const p of this.players) {
      p.intent = ruleIntent("shape", label);
      p.reflexUntil = 0;
    }
    this.pullDecisions();
    this.rev++;
  }

  goal(team) {
    const b = this.ball,
      scorer = this.player(b.lastTouchId),
      own = scorer && scorer.team !== team;
    this.score[team]++;
    this.phase = "goal";
    this.phaseT = 0;
    this.restart = null;
    this.concededBy = 1 - team;
    b.flight = null;
    this.passLive = this.shotLive = null;
    this.event("goal", team, scorer?.id ?? null,
      `GOAL ${TEAMS[team].short}! ${scorer ? scorer.id : ""}${own ? " (own goal)" : ""} · ${this.score[0]}–${this.score[1]}`);
    for (const p of this.players) p.intent = ruleIntent("shape", p.team === team ? "Celebrate" : "Back to kickoff");
  }

  endHalf() {
    this.ball.ownerId = null;
    this.ball.flight = null;
    this.restart = null;
    this.passLive = this.shotLive = null;
    this.phaseT = 0;
    if (this.clock.half === 1) {
      this.phase = "halftime";
      this.event("halftime", null, null, `Half-time · ${this.score[0]}–${this.score[1]}`);
    } else {
      this.phase = "fulltime";
      Object.assign(this.ball, { vx: 0, vy: 0, vz: 0 });
      for (const p of this.players) (p.vx = p.vy = p.speed = 0), (p.intent = ruleIntent("hold", "Full time"));
      this.event("fulltime", null, null, `Full time · ${this.score[0]}–${this.score[1]}`);
    }
  }

  // ------------------------------------------------------------------ kicks
  pressureOn(p) {
    let best = 40;
    for (const o of this.players) if (o.team !== p.team) best = Math.min(best, dist(o, p));
    return best;
  }

  kick(p, opt) {
    const b = this.ball,
      r = this.r,
      kind = opt.action === "shoot" ? "shot" : opt.action,
      from = { x: b.x, y: b.y },
      d = dist(from, opt.target),
      pressure = this.restart ? 40 : this.pressureOn(p),
      squeeze = pressure < 2.5 ? 1.5 : pressure < 4 ? 1.2 : 1;
    let k, sigma;
    if (kind === "shot") {
      const speed = rngRange(r, 24, 30);
      k = planShot(from, { ...opt.target, z: rngRange(r, 0.2, 1.7) }, speed);
      sigma = ((0.042 + 0.0021 * d) * squeeze) / p.attrs.shooting;
      k.vz *= 1 + rngNormal(r) * 0.2;
    } else {
      const lofted = !!opt.features?.lofted;
      k = planKick(kind, from, opt.target, lofted);
      sigma = (0.028 * (1 + d / 45) * squeeze * (lofted ? 1.35 : 1)) / p.attrs.passing;
      if (kind === "clear") sigma *= 2;
    }
    const a = Math.atan2(k.vy, k.vx) + rngNormal(r) * sigma,
      s = Math.hypot(k.vx, k.vy) * (1 + rngNormal(r) * 0.035);
    Object.assign(b, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: k.vz, z: 0, ownerId: null, lastTouchId: p.id, lastTouchTeam: p.team });
    b.flight = { kind, fromId: p.id, toId: opt.target_id ?? null, target: { ...opt.target }, t0: this.time };
    p.cooldown = 0.5;
    p.kickT = this.time;
    p.facing = a;
    this.possession = p.team;
    this.passLive = this.shotLive = null;
    const wasRestart = this.restart;
    if (wasRestart) {
      if (wasRestart.type === "kickoff") this.event("kickoff", p.team, p.id, `Kick-off · ${TEAMS[p.team].short}`);
      this.restart = null;
      this.phase = "play";
    }
    if (kind === "shot") {
      this.stats.shots[p.team]++;
      this.judgeShot(p, d);
    } else if (kind !== "clear") {
      this.stats.passes[p.team]++;
      this.passLive = { fromId: p.id, team: p.team, toId: opt.target_id ?? null };
      const to = opt.target_id ? ` → ${opt.target_id}` : "";
      this.event("pass", p.team, p.id, `${p.id}${to} · ${kind === "pass" ? "pass" : kind === "through" ? "through ball" : "cross"} ${Math.round(d)} m`);
    }
    const to = opt.target_id && this.player(opt.target_id);
    if (to && !to.isHuman) to.intent = ruleIntent("receive", `Meet the pass from ${p.id}`);
    this.rev++;
    this.pullDecisions(wasRestart ? Infinity : 28);
    // defenders need a beat to read the pass before they can react to it
    for (const q of this.players)
      if (q.team !== p.team && q.nextDecisionAt < this.time + 0.45) q.nextDecisionAt = this.time + 0.45 + this.r() * 0.25;
  }

  // The save is decided the instant the ball is struck (reach vs. reaction time and lateral distance);
  // the keeper then visibly dives and the outcome is applied when the ball reaches him.
  judgeShot(shooter, d) {
    const b = this.ball,
      dir = this.attackDir(shooter.team),
      gx = dir * halfL,
      gk = this.players.find((p) => p.team !== shooter.team && p.role === "GK"),
      at = (x) => {
        const t = (x - b.x) / b.vx,
          tt = t * (1 + BALL.airDrag * t * 0.5);
        return { t: tt, y: b.y + b.vy * t, z: Math.max(0, b.z + b.vz * tt - 0.5 * BALL.g * tt * tt) };
      };
    const shot = (this.shotLive = { team: shooter.team, shooterId: shooter.id, gkId: gk.id, onTarget: false, saved: false, done: false });
    this.event("shot", shooter.team, shooter.id, `${shooter.id} shoots from ${Math.round(d)} m`);
    if (b.vx * dir <= 1) return;
    const line = at(gx);
    shot.onTarget = Math.abs(line.y) < POST - 0.06 && line.z < PITCH.goalHeight - 0.08;
    if (!shot.onTarget) return;
    this.stats.onTarget[shooter.team]++;
    const between = (gk.x - b.x) * dir > 1 && Math.abs(gk.x - gx) < 14,
      k = between ? at(gk.x) : line,
      dL = Math.hypot(k.y - gk.y, Math.max(0, k.z - 1.1) * 0.7),
      reach = 0.95 + Math.max(0, k.t - 0.21) * 5.4 * gk.attrs.keeping,
      pSave = dL < reach * 0.7 ? 0.94 : dL < reach * 1.25 ? lerp(0.94, 0.06, (dL - reach * 0.7) / (reach * 0.55)) : 0.03;
    shot.saved = this.r() < pSave;
    shot.at = this.time + k.t;
    shot.y = k.y;
    shot.holds = this.r() < (Math.hypot(b.vx, b.vy) < 26.5 ? 0.62 : 0.4);
    gk.intent = ruleIntent("save", shot.saved ? "Save!" : "Dive", {
      target: { x: gk.x, y: shot.saved ? k.y : lerp(gk.y, k.y, 0.55) },
      speed: Math.min(9, Math.abs(k.y - gk.y) / Math.max(0.08, k.t)),
    });
    gk.reflexUntil = shot.at + 0.5;
  }

  resolveSave() {
    const s = this.shotLive,
      b = this.ball;
    if (!s?.saved || s.done || this.time < s.at - 1e-6 || b.flight?.kind !== "shot") return;
    const gk = this.player(s.gkId),
      r = this.r;
    s.done = true;
    gk.y = lerp(gk.y, s.y, 0.8);
    this.stats.saves[gk.team]++;
    b.lastTouchId = gk.id;
    b.lastTouchTeam = gk.team;
    if (s.holds) {
      this.event("save", gk.team, gk.id, `${gk.id} catches the shot`);
      this.gainControl(gk);
      return;
    }
    // parry: away from goal and sideways; about a third are pushed behind for a corner
    const out = -Math.sign(b.vx || 1),
      side = Math.sign(s.y - gk.y || r() - 0.5),
      behind = r() < 0.33;
    Object.assign(b, { vx: behind ? -out * rngRange(r, 3, 5) : out * rngRange(r, 3, 8), vy: side * rngRange(r, 6, 11), vz: rngRange(r, 2, 5), flight: null });
    gk.cooldown = 0.7;
    this.shotLive = this.passLive = null;
    this.event("save", gk.team, gk.id, `${gk.id} parries${behind ? " behind" : ""}`);
    this.rev++;
    this.pullDecisions(40);
  }

  // ------------------------------------------------------------------ possession
  gainControl(p) {
    const b = this.ball,
      pass = this.passLive,
      prev = this.possession;
    if (pass && p.id !== pass.fromId) {
      if (p.team === pass.team) this.stats.passesCompleted[p.team]++;
      else this.event("interception", p.team, p.id, `${p.id} cuts out the pass from ${pass.fromId}`);
    }
    if (this.shotLive && !this.shotLive.done && p.team !== this.shotLive.team && p.role !== "GK")
      this.event("interception", p.team, p.id, `${p.id} blocks the shot`);
    this.passLive = this.shotLive = null;
    Object.assign(b, { ownerId: p.id, flight: null, vz: 0, lastTouchId: p.id, lastTouchTeam: p.team });
    this.possession = p.team;
    p.possessedAt = this.time;
    p.intent = ruleIntent("hold", "Control");
    p.nextDecisionAt = this.time + 0.12; // a first touch before the next idea
    if (p.isHuman) b.z = 0;
    if (prev !== p.team)
      for (const q of this.players) if (q !== p && !q.isHuman) q.intent = ruleIntent("shape", "Transition");
    this.rev++;
    if (prev !== p.team) this.pullDecisions();
    else this.pullDecisions(22);
  }

  tryControl() {
    const b = this.ball;
    if (b.ownerId || this.phase !== "play") return;
    const shot = this.shotLive;
    let best = null,
      bestD = Infinity;
    const f = b.flight,
      age = f ? this.time - f.t0 : 9,
      pace = Math.hypot(b.vx, b.vy);
    if (age < 0.16) return; // the ball has to leave the boot before anyone can get a foot in
    for (const p of this.players) {
      if (p.cooldown > 0) continue;
      const hands = p.role === "GK" && this.inOwnArea(p, 0.5);
      // team-mates leave a pass alone unless it is for them or it has clearly gone astray
      if (f && f.toId && f.toId !== p.id && f.kind !== "shot" && p.team === b.lastTouchTeam && age < 1.2) continue;
      if (hands && shot && !shot.done && shot.gkId === p.id && b.flight?.kind === "shot" && (shot.onTarget || Math.hypot(b.vx, b.vy) > 16)) continue; // the save reflex owns this one
      const d = dist(p, b) - (b.flight?.toId === p.id ? 0.3 : 0); // the intended receiver stretches for it
      // a fizzed ball that isn't meant for you is hard to get a clean foot on
      const reachR = hands ? 1.25 : CONTROL_R - (f && f.toId !== p.id ? clamp((pace - 9) * 0.04, 0, 0.3) : 0);
      if (d < reachR && b.z <= (hands ? 2.3 : CONTROL_Z) && d < bestD) (best = p), (bestD = d);
    }
    if (!best) return;
    const p = best,
      expected = b.flight?.toId === p.id,
      // a player meeting his own pass cushions it; anyone else has to deal with the full closing speed
      rel = expected ? Math.hypot(b.vx, b.vy) : Math.hypot(b.vx - p.vx, b.vy - p.vy),
      hands = p.role === "GK" && this.inOwnArea(p, 0.5);
    let miss = (clamp((rel - (expected ? 18 : 15)) / 16, 0, 0.75) * (expected ? 0.45 : 1) * (hands ? 0.4 : 1)) / p.attrs.control + (b.z > 0.7 && !hands ? 0.12 : 0);
    if (b.flight?.kind === "shot" && !hands) miss = Math.max(miss, 0.8); // blocks rarely stick
    if (this.r() < miss) {
      // heavy touch: the ball squirts off at an angle and everyone re-evaluates
      const a = Math.atan2(b.vy, b.vx) + (this.r() < 0.5 ? -1 : 1) * rngRange(this.r, 0.5, 1.4),
        s = Math.hypot(b.vx, b.vy) * rngRange(this.r, 0.25, 0.45);
      Object.assign(b, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: b.z > 0.3 ? 1.5 : rngRange(this.r, 0, 2), lastTouchId: p.id, lastTouchTeam: p.team, flight: null });
      p.cooldown = 0.45;
      if (this.passLive && p.team !== this.passLive.team) this.passLive = null;
      if (this.shotLive) this.shotLive = null;
      this.rev++;
      this.pullDecisions(30);
      return;
    }
    this.gainControl(p);
  }

  tryTackle(dt) {
    const c = this.owner();
    if (!c || this.phase !== "play" || this.keeperProtected(c)) return;
    for (const d of this.players) {
      if (d.team === c.team || d.cooldown > 0) continue;
      const pressing = d.isHuman || d.intent.type === "press" || (CHASERS.has(d.intent.type) && d.role !== "GK") || d.intent.type === "gk_rush";
      if (!pressing || Math.min(dist(d, c), dist(d, this.ball)) > TACKLE_R) continue;
      // front-on challenges win the ball far more often than ones from behind
      const front = Math.cos(angleDiff(c.facing, Math.atan2(d.y - c.y, d.x - c.x))),
        angle = front > 0.3 ? 1 : front > -0.3 ? 0.75 : 0.42,
        rate = (1.25 * angle * d.attrs.tackling) / c.attrs.control;
      if (this.r() >= rate * dt) continue;
      this.stats.tackles[d.team]++;
      this.event("tackle", d.team, d.id, `${d.id} wins the ball from ${c.id}`);
      c.cooldown = 0.6;
      if (this.r() < 0.62) this.gainControl(d);
      else {
        const a = Math.atan2(d.vy + (c.y - d.y) * 0.5, d.vx + (c.x - d.x) * 0.5) + rngNormal(this.r) * 0.8,
          s = rngRange(this.r, 4, 8);
        Object.assign(this.ball, { ownerId: null, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: rngRange(this.r, 0, 2), lastTouchId: d.id, lastTouchTeam: d.team, flight: null });
        d.cooldown = 0.25;
        this.passLive = null;
        this.rev++;
        this.pullDecisions(30);
      }
      return;
    }
  }

  // ------------------------------------------------------------------ human control
  setHuman(playerId) {
    const p = playerId ? this.player(playerId) : null;
    for (const q of this.players) q.isHuman = false;
    this.human = p ? { playerId: p.id } : null;
    if (p) {
      p.isHuman = true;
      p.pending = false;
      p.intent = ruleIntent("human", "Human control");
    }
    return !!p;
  }

  switchHuman() {
    const team = this.human ? this.player(this.human.playerId).team : 0,
      hit = this.ball.ownerId ? this.ball : this.forecast()[Math.min(12, this.forecast().length - 1)];
    const next = this.players
      .filter((p) => p.team === team && p.role !== "GK")
      .sort((a, b) => dist(a, hit) - dist(b, hit))[0];
    const prev = this.human && this.player(this.human.playerId);
    this.setHuman(next.id);
    if (prev && prev !== next) (prev.intent = ruleIntent("shape", "Back to shape")), (prev.nextDecisionAt = this.time);
    return next.id;
  }

  humanPass(p) {
    const dir = this.attackDir(p.team),
      line = this.offsideLineN(p.team);
    let best = null,
      bestScore = Infinity;
    for (const m of this.players) {
      if (m.team !== p.team || m === p) continue;
      const d = dist(p, m);
      if (d < 3 || d > 50 || line - m.x * dir < 0) continue;
      const off = Math.abs(angleDiff(p.facing, Math.atan2(m.y - p.y, m.x - p.x))),
        score = off / 0.6 + d / 40 + (off > 1.7 ? 5 : 0);
      if (score < bestScore) (bestScore = score), (best = m);
    }
    if (!best) return false;
    const d = dist(p, best),
      lead = clamp(d / 18, 0.2, 1.1) * 0.55,
      target = { x: clamp(best.x + best.vx * lead, -halfL + 1, halfL - 1), y: clamp(best.y + best.vy * lead, -halfW + 1, halfW - 1) };
    this.kick(p, { action: "pass", target_id: best.id, target, features: { lofted: d > 30 } });
    this.setHuman(best.id); // control follows the ball
    p.intent = ruleIntent("shape", "Back to shape");
    p.nextDecisionAt = this.time + 0.3;
    return true;
  }

  humanShoot(p) {
    const dir = this.attackDir(p.team),
      gk = this.players.find((q) => q.team !== p.team && q.role === "GK"),
      side = gk.y > p.y * 0.15 ? -1 : 1;
    this.kick(p, { action: "shoot", target_id: null, target: { x: dir * halfL, y: side * (POST - 0.75) } });
    return true;
  }

  // ------------------------------------------------------------------ movement
  targetFor(p) {
    const b = this.ball,
      r = this.restart,
      it = p.intent;
    if (this.phase === "goal" || this.phase === "halftime") return { ...this.kickoffSpotAfter(p), effort: 0.6 };
    if (this.phase === "kickoff") {
      if (r.takerId === p.id && r.ready) return { x: p.x, y: p.y, effort: 0 };
      return { ...this.kickoffSpot(p), effort: 0.8 };
    }
    if (r?.takerId === p.id) {
      if (r.ready) return { x: p.x, y: p.y, effort: 0 };
      const dir = this.attackDir(p.team),
        spot = r.placed ? b : r;
      return { x: spot.x - dir * 0.5, y: spot.y, effort: 1, snug: true };
    }
    if (!b.ownerId && b.flight?.toId === p.id) return { ...this.interceptFor(p, 0.15), effort: 1, snug: true };
    let t;
    switch (it.type) {
      case "save":
        return { ...it.target, effort: 1, snug: true, speed: it.speed };
      case "press": {
        const o = this.owner();
        if (o && o.team !== p.team) t = { x: o.x + o.vx * 0.3, y: o.y + o.vy * 0.3, effort: 1, snug: true };
        else if (!o) {
          // ball in flight: close down the man it is going to rather than gambling on the cut-out
          const to = b.flight?.toId && this.player(b.flight.toId);
          t = { ...this.interceptFor(to && to.team !== p.team ? to : p, 0.15), effort: 1, snug: true };
        }
        break;
      }
      case "chase":
      case "gk_rush":
      case "gk_claim":
        if (!b.ownerId || this.owner().team !== p.team) t = { ...this.interceptFor(p, 0.1), effort: 1, snug: true };
        break;
      case "mark": {
        const o = this.player(it.targetId);
        if (o) t = { ...markSpot({ x: -this.attackDir(p.team) * halfL, y: 0 }, o, b), effort: 0.95 };
        break;
      }
      case "cover":
        t = { ...coverSpot(this, p), effort: 0.9 };
        break;
      case "gk_set":
        t = { ...keeperSetSpot(this, p), effort: 0.85 };
        break;
      case "run": {
        const dir = this.attackDir(p.team),
          xN = Math.min(it.target.x * dir, this.offsideLineN(p.team) - 0.4);
        t = { x: xN * dir, y: it.target.y, effort: 1 };
        break;
      }
      case "support":
        t = { ...it.target, effort: 0.95 };
        break;
      case "dribble":
        t = { ...it.target, effort: 1, snug: true };
        break;
      case "hold":
        return { x: p.x, y: p.y, effort: 0 };
    }
    if (!t) {
      t = this.anchor(p);
      t.effort = dist(p, t) > 10 ? 0.95 : 0.72;
    }
    if (r && r.team !== p.team) {
      // opponents respect the restart distance
      const d = Math.hypot(t.x - r.x, t.y - r.y);
      if (d < RESTART_KEEP + 0.5) {
        const dir = this.attackDir(p.team),
          ux = d > 0.5 ? (t.x - r.x) / d : -dir,
          uy = d > 0.5 ? (t.y - r.y) / d : 0;
        t.x = clamp(r.x + ux * (RESTART_KEEP + 0.6), -halfL + 1, halfL - 1);
        t.y = clamp(r.y + uy * (RESTART_KEEP + 0.6), -halfW + 1, halfW - 1);
      }
    }
    return t;
  }

  kickoffSpotAfter(p) {
    // during the goal pause nobody is a taker yet
    const saved = this.restart;
    this.restart = null;
    const s = this.kickoffSpot(p);
    this.restart = saved;
    return s;
  }

  movePlayer(p, dt) {
    let wx = 0,
      wy = 0;
    const hasBall = this.ball.ownerId === p.id;
    if (p.isHuman) {
      const i = this.humanInput,
        l = Math.hypot(i.mx, i.my),
        top = p.maxSpeed * (i.sprint ? 1.04 : 0.8) * (hasBall ? 0.88 : 1);
      if (l > 0.05) (wx = (i.mx / Math.max(1, l)) * top), (wy = (i.my / Math.max(1, l)) * top);
      if (this.restart?.takerId === p.id && this.restart.ready) wx = wy = 0;
    } else {
      const t = this.targetFor(p),
        dx = t.x - p.x,
        dy = t.y - p.y,
        d = Math.hypot(dx, dy);
      if (d > 0.05 && t.effort > 0) {
        const top = t.speed ?? p.maxSpeed * t.effort * (hasBall ? 0.88 : 1),
          v = Math.min(top, d * (t.snug ? 6 : 2.6)); // arrive: ease off near the target
        wx = (dx / d) * v;
        wy = (dy / d) * v;
      }
    }
    const ax = wx - p.vx,
      ay = wy - p.vy,
      a = Math.hypot(ax, ay),
      cap = ACCEL * dt * (p.intent.type === "save" ? 2.5 : 1);
    if (a > cap) (p.vx += (ax / a) * cap), (p.vy += (ay / a) * cap);
    else (p.vx = wx), (p.vy = wy);
    p.x = clamp(p.x + p.vx * dt, -halfL - 3, halfL + 3);
    p.y = clamp(p.y + p.vy * dt, -halfW - 3, halfW + 3);
    p.speed = Math.hypot(p.vx, p.vy);
    const look = p.speed > 0.6 && p.intent.type !== "save" ? Math.atan2(p.vy, p.vx) : Math.atan2(this.ball.y - p.y, this.ball.x - p.x);
    if (p.speed > 0.6 || !hasBall) p.facing = turnToward(p.facing, look, 9 * dt);
    if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt);
  }

  separate() {
    const ps = this.players,
      R = 0.85;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i],
          b = ps[j],
          dx = b.x - a.x,
          dy = b.y - a.y;
        if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
        const d = Math.hypot(dx, dy);
        if (d >= R) continue;
        const push = (R - d) * 0.35,
          ux = d > 1e-3 ? dx / d : 1,
          uy = d > 1e-3 ? dy / d : 0;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
  }

  // ------------------------------------------------------------------ ball
  moveBall(dt) {
    const b = this.ball,
      o = this.owner(),
      r = this.restart;
    if (r && !r.placed) {
      // dead ball trundles on for a moment before it is set down for the restart
      advanceBall(b, dt);
      b.vx *= 1 - 2.5 * dt;
      b.vy *= 1 - 2.5 * dt;
      return;
    }
    if (r) return;
    if (o) {
      const held = this.keeperProtected(o),
        reach = held ? 0.35 : 0.7,
        k = 1 - Math.exp(-20 * dt);
      b.x = lerp(b.x, o.x + Math.cos(o.facing) * reach, k);
      b.y = lerp(b.y, o.y + Math.sin(o.facing) * reach, k);
      b.z = lerp(b.z, held ? 1.05 : 0, k);
      b.vx = o.vx;
      b.vy = o.vy;
      b.vz = 0;
      return;
    }
    const px = b.x,
      py = b.y,
      pz = b.z;
    advanceBall(b, dt);
    if (this.phase === "goal") {
      // keep it in the net
      b.vx *= 1 - 6 * dt;
      b.vy *= 1 - 6 * dt;
      b.x = clamp(b.x, -halfL - PITCH.goalDepth, halfL + PITCH.goalDepth);
      return;
    }
    if (this.phase !== "play") return;
    if (Math.abs(b.x) > halfL + BALL.radius) {
      const side = Math.sign(b.x),
        t = clamp((side * halfL - px) / (b.x - px || 1), 0, 1),
        y = lerp(py, b.y, t),
        z = lerp(pz, b.z, t),
        defending = this.attackDir(0) === side ? 1 : 0; // team whose goal is on this side
      if (Math.abs(y) < POST - 0.06 && z < PITCH.goalHeight - 0.08) return this.goal(1 - defending);
      this.outOverGoalLine(side, y, defending);
    } else if (Math.abs(b.y) > halfW + BALL.radius) {
      const team = b.lastTouchTeam === null ? 0 : 1 - b.lastTouchTeam;
      this.startRestart("throw_in", team, clamp(b.x, -halfL + 1, halfL - 1), Math.sign(b.y) * (halfW - 0.15));
    }
  }

  outOverGoalLine(side, y, defending) {
    const b = this.ball;
    if (b.lastTouchTeam === defending)
      this.startRestart("corner", 1 - defending, side * (halfL - 0.6), Math.sign(y || 1) * (halfW - 0.6));
    else this.startRestart("goal_kick", defending, side * (halfL - PITCH.goalAreaDepth), Math.sign(y || 1) * 5);
  }

  checkOwnedBallOut() {
    const b = this.ball;
    if (!b.ownerId || this.phase !== "play") return;
    if (Math.abs(b.y) > halfW + BALL.radius) {
      this.startRestart("throw_in", 1 - b.lastTouchTeam, clamp(b.x, -halfL + 1, halfL - 1), Math.sign(b.y) * (halfW - 0.15));
    } else if (Math.abs(b.x) > halfL + BALL.radius) {
      const side = Math.sign(b.x);
      if (Math.abs(b.y) < POST - 0.06) return this.goal(this.attackDir(0) === side ? 0 : 1);
      this.outOverGoalLine(side, b.y, this.attackDir(0) === side ? 1 : 0);
    }
  }

  stepRestart(dt) {
    const r = this.restart,
      b = this.ball,
      taker = this.player(r.takerId);
    r.elapsed += dt;
    if (!r.placed && r.elapsed > 0.9) {
      Object.assign(b, { x: r.x, y: r.y, z: 0, vx: 0, vy: 0, vz: 0, lastTouchTeam: r.team });
      r.placed = true;
      this.rev++;
    }
    if (!r.placed) return;
    if (!r.ready) {
      let settled = r.elapsed > r.minWait && dist(taker, b) < 1.1;
      if (settled && r.type === "kickoff" && r.elapsed < 8)
        settled = this.players.every((p) => p === taker || p.isHuman || dist(p, this.kickoffSpot(p)) < 2.5);
      if (!settled && r.elapsed > RESTART_AUTO_S + 3) {
        // nobody should wait forever for a slow walker
        const dir = this.attackDir(taker.team);
        Object.assign(taker, { x: b.x - dir * 0.5, y: b.y, vx: 0, vy: 0 });
        settled = true;
      }
      if (settled) {
        r.ready = true;
        r.readyAt = this.time;
        b.ownerId = taker.id;
        b.lastTouchId = taker.id;
        b.lastTouchTeam = taker.team;
        taker.possessedAt = this.time;
        taker.facing = Math.atan2(-b.y, this.attackDir(taker.team) * 20 - b.x * 0.2);
        taker.nextDecisionAt = this.time + 0.35;
        this.rev++;
      }
    } else if (this.time - r.readyAt > (r.type === "kickoff" ? 2.5 : RESTART_AUTO_S - r.minWait)) this.forceRelease(taker);
  }

  // ------------------------------------------------------------------ main step
  step(dt) {
    if (this.paused || this.phase === "fulltime" || !(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.phaseT += dt;
    this.rev++;
    const c = this.clock;

    if (this.phase === "goal" && this.phaseT > 2.8) this.setupKickoff(this.concededBy, false);
    else if (this.phase === "halftime" && this.phaseT > 3) {
      c.half = 2;
      c.elapsed = 0;
      this.setupKickoff(1, true);
    }
    if (this.phase === "play" || this.phase === "restart") {
      c.elapsed += dt;
      if (this.possession !== null && this.phase === "play") this.stats.possessionTime[this.possession] += dt;
      if (c.elapsed >= c.halfSeconds && !(this.shotLive && !this.shotLive.done && this.ball.flight)) return this.endHalf();
    }
    c.minute = Math.min(c.half * 45, Math.floor((c.half - 1) * 45 + (c.elapsed / c.halfSeconds) * 45));

    const h = this.human && this.player(this.human.playerId);
    if (h) {
      const i = this.humanInput;
      if (this.ball.ownerId === h.id && ["play", "restart", "kickoff"].includes(this.phase)) {
        if (i.shoot) this.humanShoot(h);
        else if (i.pass) this.humanPass(h);
      }
      i.pass = i.shoot = false;
    }

    if (this.restart) this.stepRestart(dt);
    for (const p of this.players) this.movePlayer(p, dt);
    this.separate();
    this.moveBall(dt);
    if (this.phase === "play") {
      this.checkOwnedBallOut();
      this.resolveSave();
      this.tryControl();
      this.tryTackle(dt);
      const f = this.ball.flight;
      if (f && this.time - f.t0 > 7) this.ball.flight = null;
    }
    this.watchdog();
  }

  // ------------------------------------------------------------------ snapshots
  sharedState() {
    const b = this.ball,
      r1 = (v) => round(v, 1);
    return {
      minute: this.clock.minute,
      half: this.clock.half,
      score: [...this.score],
      phase: this.phase,
      restart: this.restart?.type ?? null,
      possession: this.possession === null ? null : TEAMS[this.possession].id,
      ball: { x: r1(b.x), y: r1(b.y), z: r1(b.z), vx: r1(b.vx), vy: r1(b.vy), owner: b.ownerId, flight: b.flight?.kind ?? null },
      players: this.players.map((p) => [p.id, p.role, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy)]),
    };
  }

  snapshot() {
    const r2 = (v) => round(v, 2);
    return JSON.parse(
      JSON.stringify({
        seed: this.seed, time: r2(this.time), paused: this.paused, clock: this.clock, phase: this.phase,
        restart: this.restart, score: this.score, possession: this.possession, stats: this.stats,
        human: this.human, formations: this.formations, decisionsMade: this.decisionsMade,
        ball: { ...this.ball, x: r2(this.ball.x), y: r2(this.ball.y), z: r2(this.ball.z) },
        players: this.players.map((p) => ({
          id: p.id, team: p.team, number: p.number, role: p.role, x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy),
          facing: r2(p.facing), speed: r2(p.speed), maxSpeed: p.maxSpeed, home: p.home, attrs: p.attrs, intent: p.intent,
          decision: p.decision && { ...p.decision, options: undefined, optionIds: Object.keys(p.decision.options) },
          nextDecisionAt: r2(p.nextDecisionAt), pending: p.pending, cooldown: r2(p.cooldown), isHuman: p.isHuman,
        })),
        events: this.events.slice(-30),
      }),
    );
  }
}
