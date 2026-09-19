// Mock Simulation / MatchScene / DecisionLoop for hud-test.html only.
// They follow docs/ARCHITECTURE.md closely enough to exercise every HUD path
// without the real simulation, three.js scene or a server.

export const PITCH = { length: 105, width: 68, halfL: 52.5, halfW: 34, goalWidth: 7.32, goalHeight: 2.44, goalDepth: 2.2, penaltyAreaDepth: 16.5, penaltyAreaWidth: 40.32, goalAreaDepth: 5.5, goalAreaWidth: 18.32, centerCircle: 9.15, penaltySpot: 11, cornerArc: 1 };
export const TEAMS = [
  { id: "home", name: "Jev United", short: "JEV", prefix: "h", colors: { shirt: "#e82127", shorts: "#ffffff", socks: "#e82127", keeper: "#f2b705" } },
  { id: "away", name: "System One FC", short: "SYS", prefix: "a", colors: { shirt: "#3e6ae1", shorts: "#171a20", socks: "#3e6ae1", keeper: "#2fbf71" } },
];
const SLOTS = {
  "4-4-2": [["GK", 1, -0.96, 0], ["LB", 2, -0.6, -0.7], ["CB", 4, -0.68, -0.25], ["CB", 5, -0.68, 0.25], ["RB", 3, -0.6, 0.7], ["LM", 11, -0.1, -0.75], ["CM", 8, -0.2, -0.22], ["CM", 6, -0.2, 0.22], ["RM", 7, -0.1, 0.75], ["ST", 9, 0.4, -0.2], ["ST", 10, 0.4, 0.2]],
  "4-3-3": [["GK", 1, -0.96, 0], ["LB", 2, -0.6, -0.7], ["CB", 4, -0.68, -0.25], ["CB", 5, -0.68, 0.25], ["RB", 3, -0.6, 0.7], ["DM", 6, -0.3, 0], ["CM", 8, -0.12, -0.35], ["CM", 10, -0.12, 0.35], ["LW", 11, 0.38, -0.7], ["ST", 9, 0.45, 0], ["RW", 7, 0.38, 0.7]],
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const round1 = (v) => Math.round(v * 10) / 10;

export class Simulation {
  constructor(seed = 1, { formations = ["4-4-2", "4-3-3"], halfSeconds = 180 } = {}) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.time = 0;
    this.paused = false;
    this.clock = { half: 1, elapsed: 0, halfSeconds, minute: 0 };
    this.phase = "kickoff";
    this.phaseT = 1.2;
    this.restart = { type: "kickoff", team: 0, x: 0, y: 0, takerId: "h9" };
    this.score = [0, 0];
    this.possession = 0;
    this.stats = { possessionTime: [0, 0], shots: [0, 0], onTarget: [0, 0], passes: [0, 0], passesCompleted: [0, 0], tackles: [0, 0], saves: [0, 0], corners: [0, 0] };
    this.events = [];
    this.human = null;
    this.humanInput = { mx: 0, my: 0, sprint: false, pass: false, shoot: false };
    this.batch = 0;
    this.mockDecisions = 0; // read by the mock DecisionLoop
    this.mockSource = "local";
    this.players = [];
    formations.forEach((name, team) => {
      for (const [role, number, ax, ay] of SLOTS[name] ?? SLOTS["4-4-2"]) {
        const p = { id: `${TEAMS[team].prefix}${number}`, team, number, role, x: 0, y: 0, vx: 0, vy: 0, facing: 0, speed: 0, maxSpeed: 7.5, home: { ax, ay }, intent: { type: "shape", target: null, targetId: null, label: "Hold shape" }, decision: null, nextDecisionAt: this.rng() * 1.2, pending: false, cooldown: 0, kickT: -10, isHuman: false, lastDecisionState: null };
        const slot = this.slot(p);
        p.x = slot.x;
        p.y = slot.y;
        this.players.push(p);
      }
    });
    this.ball = { x: 0, y: 0, z: 0.11, vx: 0, vy: 0, vz: 0, ownerId: "h9", lastTouchId: "h9", lastTouchTeam: 0, flight: null };
    this.holdT = 1;
    this.event("kickoff", 0, "h9", "Kick-off");
  }
  attackDir(team) {
    return (team === 0 ? 1 : -1) * (this.clock.half === 1 ? 1 : -1);
  }
  player(id) {
    return this.players.find((p) => p.id === id) ?? null;
  }
  teamPlayers(team) {
    return this.players.filter((p) => p.team === team);
  }
  owner() {
    return this.ball.ownerId ? this.player(this.ball.ownerId) : null;
  }
  slot(p) {
    const dir = this.attackDir(p.team);
    const pull = p.role === "GK" ? 0.05 : 0.35;
    const bx = this.ball?.x ?? 0,
      by = this.ball?.y ?? 0;
    return { x: p.home.ax * dir * 46 + bx * pull, y: p.home.ay * dir * 27 + by * pull * 0.5 };
  }
  event(type, team, playerId, text) {
    this.events.push({ t: this.time, minute: this.clock.minute, type, team, playerId, text });
    if (this.events.length > 200) this.events.shift();
  }
  decisionDue() {
    return [];
  }
  decisionState(player) {
    return player.lastDecisionState;
  }
  applyDecision() {
    return false;
  }
  decideLocally() {}
  setHuman(id) {
    for (const p of this.players) p.isHuman = false;
    const player = id ? this.player(id) : null;
    this.human = player ? { playerId: player.id } : null;
    if (player) player.isHuman = true;
  }
  switchHuman() {
    const pool = this.teamPlayers(0).filter((p) => p.role !== "GK" && !p.isHuman);
    pool.sort((a, b) => dist(a, this.ball) - dist(b, this.ball));
    this.setHuman(pool[0].id);
  }
  sharedState() {
    return { minute: this.clock.minute, half: this.clock.half, score: [...this.score], phase: this.phase, restart: this.restart?.type ?? null, possession: this.possession == null ? null : TEAMS[this.possession].id, ball: { x: round1(this.ball.x), y: round1(this.ball.y), z: round1(this.ball.z), vx: round1(this.ball.vx), vy: round1(this.ball.vy), owner: this.ball.ownerId, flight: this.ball.flight?.kind ?? null }, players: this.players.map((p) => [p.id, p.role, round1(p.x), round1(p.y), round1(p.vx), round1(p.vy)]) };
  }
  snapshot() {
    return { seed: this.seed, time: round1(this.time), clock: { ...this.clock }, phase: this.phase, restart: this.restart, score: [...this.score], possession: this.possession, human: this.human, ball: { ...this.ball }, players: this.players.map(({ lastDecisionState, decision, ...p }) => ({ ...p, decision: decision ? { ...decision, options: undefined } : null })), stats: this.stats, events: this.events.slice(-20) };
  }
  decide(p) {
    const carrier = this.ball.ownerId === p.id;
    const mates = this.teamPlayers(p.team).filter((m) => m !== p && m.role !== "GK");
    const options = {};
    const add = (id, action, label, target, targetId = null) => {
      options[id] = { action, target_id: targetId, target, label, features: { dist_m: round1(dist(p, target)) }, path: [{ x: p.x, y: p.y, z: 0 }, { x: target.x, y: target.y, z: 0 }] };
    };
    const dir = this.attackDir(p.team);
    const goal = { x: dir * 52.5, y: 0 };
    let kind;
    if (carrier) {
      kind = "carrier";
      if (dist(p, goal) < 30) add("shoot", "shoot", `Shoot ${Math.round(dist(p, goal))} m`, goal);
      for (const m of mates.sort((a, b) => dist(a, p) - dist(b, p)).slice(0, 4))
        add(`pass_${m.id}`, "pass", `Pass to ${m.id} (${m.role}) ${Math.round(dist(m, p))} m${this.rng() > 0.5 ? ", open" : ""}`, m, m.id);
      add("dribble_fwd", "dribble", "Dribble forward 6 m", { x: p.x + dir * 6, y: p.y });
      add("hold", "hold", "Shield the ball", p);
    } else if (p.role === "GK") {
      kind = "keeper";
      add("gk_set", "gk_set", "Set on the ball line", { x: -dir * 50, y: this.ball.y * 0.1 });
      add("gk_rush", "gk_rush", "Rush the carrier", this.ball);
    } else if (this.possession === p.team) {
      kind = "attack";
      add("support_near", "support", "Support near the carrier", { x: this.ball.x - dir * 6, y: (p.y + this.ball.y) / 2 });
      add("support_wide", "support", "Offer width", { x: p.x + dir * 4, y: Math.sign(p.y || 1) * 28 });
      add("run_behind", "run", "Run in behind", { x: p.x + dir * 14, y: p.y * 0.8 });
      add("shape", "shape", "Hold formation slot", this.slot(p));
    } else {
      kind = "defend";
      add("press", "press", "Press the carrier", this.ball);
      const mark = this.teamPlayers(1 - p.team).sort((a, b) => dist(a, p) - dist(b, p))[0];
      add(`mark_${mark.id}`, "mark", `Mark ${mark.id} (${mark.role})`, mark, mark.id);
      add("cover", "cover", "Cover the space behind", { x: p.x - dir * 6, y: p.y * 0.7 });
      add("shape", "shape", "Hold formation slot", this.slot(p));
    }
    const ids = Object.keys(options);
    const weights = ids.map(() => 0.15 + this.rng() ** 2.2);
    const total = weights.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, Math.round((weights[i] / total) * 1000) / 1000]));
    const choice = ids.reduce((best, id) => (probabilities[id] > probabilities[best] ? id : best), ids[0]);
    const localChoice = this.rng() > 0.35 ? choice : ids[Math.floor(this.rng() * ids.length)];
    const batchId = `b${++this.batch}`;
    p.lastDecisionState = { batch_id: batchId, player_id: p.id, team: TEAMS[p.team].id, role: p.role, number: p.number, kind, options, local: { choice: localChoice, probabilities } };
    const source = this.mockSource === "jev" ? (this.rng() > 0.08 ? "jev" : "local") : "local";
    p.decision = { batchId, kind, choice, label: options[choice].label, source, probabilities, confidence: probabilities[choice], at: this.time, options, latencyMs: source === "jev" ? Math.round(90 + this.rng() * 260) : undefined };
    p.intent = { type: options[choice].action, target: options[choice].target, targetId: options[choice].target_id, label: options[choice].label };
    p.nextDecisionAt = this.time + (carrier ? 0.3 : dist(p, this.ball) < 15 ? 0.55 : 1.2);
    this.mockDecisions++;
    return p.decision;
  }
  step(dt) {
    this.time += dt;
    const c = this.clock;
    if (this.phase === "fulltime") return;
    if (["kickoff", "goal", "halftime", "restart"].includes(this.phase)) {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        if (this.phase === "goal") {
          this.phase = "kickoff";
          this.phaseT = 1.2;
          this.restart = { type: "kickoff", team: this.possession, x: 0, y: 0, takerId: null };
          this.resetPositions();
        } else if (this.phase === "halftime") {
          c.half = 2;
          c.elapsed = 0;
          this.phase = "kickoff";
          this.phaseT = 1.2;
          this.restart = { type: "kickoff", team: 1, x: 0, y: 0, takerId: null };
          this.resetPositions();
        } else {
          this.phase = "play";
          this.restart = null;
        }
      }
      if (this.phase !== "play") return this.movePlayers(dt, 0.4);
    }
    c.elapsed += dt;
    c.minute = Math.min(90, Math.floor((c.half - 1) * 45 + (c.elapsed / c.halfSeconds) * 45));
    if (c.elapsed >= c.halfSeconds) {
      if (c.half === 1) {
        this.phase = "halftime";
        this.phaseT = 3;
        this.event("halftime", null, null, `Half-time ${this.score.join("–")}`);
      } else {
        this.phase = "fulltime";
        this.event("fulltime", null, null, `Full-time ${this.score.join("–")}`);
      }
      return;
    }
    if (this.possession != null) this.stats.possessionTime[this.possession] += dt;
    for (const p of this.players) if (!p.isHuman && this.time >= p.nextDecisionAt) this.decide(p);
    this.moveBall(dt);
    this.movePlayers(dt, 1);
  }
  resetPositions() {
    for (const p of this.players) {
      const dir = this.attackDir(p.team);
      p.x = p.home.ax * dir * 46 - dir * 4;
      p.y = p.home.ay * dir * 27;
    }
    const taker = this.teamPlayers(this.restart?.team ?? 0).find((p) => p.role === "ST");
    taker.x = taker.y = 0;
    Object.assign(this.ball, { x: 0, y: 0, z: 0.11, vx: 0, vy: 0, ownerId: taker.id, flight: null });
    this.possession = taker.team;
    this.holdT = 1;
  }
  moveBall(dt) {
    const b = this.ball,
      owner = this.owner();
    if (owner) {
      const dir = this.attackDir(owner.team);
      b.x = owner.x + Math.cos(owner.facing) * 0.7;
      b.y = owner.y + Math.sin(owner.facing) * 0.7;
      b.z = 0.11;
      this.holdT -= dt;
      const human = owner.isHuman;
      const wantsPass = human ? this.humanInput.pass : this.holdT <= 0;
      const wantsShot = human ? this.humanInput.shoot : this.holdT <= 0 && Math.abs(owner.x - dir * 52.5) < 24 && this.rng() > 0.4;
      this.humanInput.pass = this.humanInput.shoot = false;
      if (wantsShot) this.kick(owner, { x: dir * 52.5, y: (this.rng() - 0.5) * 9 }, "shot", null);
      else if (wantsPass) {
        const mates = this.teamPlayers(owner.team).filter((m) => m !== owner && m.role !== "GK" && (m.x - owner.x) * dir > -12);
        const to = mates[Math.floor(this.rng() * mates.length)] ?? this.teamPlayers(owner.team)[5];
        this.kick(owner, to, "pass", to.id);
      }
      return;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z = b.flight ? 0.11 + Math.max(0, Math.sin((this.flightT / this.flightD) * Math.PI)) * (b.flight.kind === "shot" ? 1.2 : 2.2) : 0.11;
    this.flightT += dt;
    if (!b.flight || this.flightT < this.flightD) return;
    const flight = b.flight;
    b.flight = null;
    b.vx = b.vy = 0;
    if (flight.kind === "shot") {
      const team = b.lastTouchTeam;
      this.stats.onTarget[team] += 1;
      if (this.rng() > 0.55) {
        this.score[team]++;
        this.phase = "goal";
        this.phaseT = 2.6;
        this.possession = 1 - team;
        this.event("goal", team, b.lastTouchId, `${b.lastTouchId} scores! ${this.score.join("–")}`);
      } else {
        const keeper = this.teamPlayers(1 - team)[0];
        this.stats.saves[1 - team]++;
        this.event("save", 1 - team, keeper.id, `${keeper.id} saves from ${b.lastTouchId}`);
        if (this.rng() > 0.6) {
          this.stats.corners[team]++;
          this.phase = "restart";
          this.phaseT = 1.6;
          this.restart = { type: "corner", team, x: b.x, y: 34 * Math.sign(b.y || 1), takerId: null };
          this.event("corner", team, null, `Corner to ${TEAMS[team].name}`);
        }
        this.give(keeper);
      }
      return;
    }
    const receiver = this.player(flight.toId);
    if (this.rng() > 0.2) {
      this.stats.passesCompleted[receiver.team]++;
      this.give(receiver);
    } else {
      const thief = this.teamPlayers(1 - receiver.team).filter((p) => p.role !== "GK").sort((a, c) => dist(a, b) - dist(c, b))[0];
      const tackle = this.rng() > 0.5;
      this.stats.tackles[thief.team] += tackle ? 1 : 0;
      this.event(tackle ? "tackle" : "interception", thief.team, thief.id, tackle ? `${thief.id} wins it from ${receiver.id}` : `${thief.id} cuts out the pass`);
      thief.x = b.x;
      thief.y = b.y;
      this.give(thief);
    }
  }
  give(player) {
    this.ball.ownerId = player.id;
    this.possession = player.team;
    this.holdT = 0.7 + this.rng() * 1.3;
    player.nextDecisionAt = this.time;
  }
  kick(from, target, kind, toId) {
    const b = this.ball;
    const d = Math.max(4, dist(from, target));
    this.flightD = d / (kind === "shot" ? 24 : 16);
    this.flightT = 0;
    b.vx = (target.x - b.x) / this.flightD;
    b.vy = (target.y - b.y) / this.flightD;
    b.ownerId = null;
    b.lastTouchId = from.id;
    b.lastTouchTeam = from.team;
    b.flight = { kind, fromId: from.id, toId, target: { x: target.x, y: target.y } };
    from.kickT = this.time;
    if (kind === "shot") {
      this.stats.shots[from.team]++;
      this.event("shot", from.team, from.id, `${from.id} shoots from ${Math.round(d)} m`);
    } else {
      this.stats.passes[from.team]++;
      this.event("pass", from.team, from.id, `${from.id} passes to ${toId}`);
    }
  }
  movePlayers(dt, pace) {
    for (const p of this.players) {
      let tx, ty;
      if (p.isHuman) {
        tx = p.x + this.humanInput.mx * 10;
        ty = p.y + this.humanInput.my * 10;
      } else {
        const receiving = this.ball.flight?.toId === p.id;
        const target = receiving ? this.ball.flight.target : this.ball.ownerId === p.id ? { x: p.x + this.attackDir(p.team) * 8, y: p.y * 0.97 } : (p.intent.target ?? this.slot(p));
        const slot = this.slot(p);
        const mix = receiving || this.ball.ownerId === p.id ? 1 : 0.45;
        tx = slot.x + (target.x - slot.x) * mix;
        ty = slot.y + (target.y - slot.y) * mix;
      }
      const dx = tx - p.x,
        dy = ty - p.y,
        d = Math.hypot(dx, dy);
      const max = (p.isHuman && this.humanInput.sprint ? 8.5 : 6) * pace;
      const v = Math.min(max, d * 2);
      p.vx = d > 0.05 ? (dx / d) * v : 0;
      p.vy = d > 0.05 ? (dy / d) * v : 0;
      p.x = Math.max(-54, Math.min(54, p.x + p.vx * dt));
      p.y = Math.max(-35, Math.min(35, p.y + p.vy * dt));
      p.speed = v;
      if (v > 0.3) p.facing = Math.atan2(p.vy, p.vx);
      if (p.isHuman && !this.ball.ownerId && !this.ball.flight && dist(p, this.ball) < 1.2) this.give(p);
    }
  }
}

// Draws a flat broadcast-style pitch so the HUD sits on something plausible.
export class MatchScene {
  constructor(canvas, sim, labelsEl) {
    Object.assign(this, { canvas, sim, labelsEl });
    this.ctx = canvas.getContext("2d");
    this.cameraNames = ["Broadcast", "Tactical", "Follow", "Behind goal"];
    this.cameraName = "Broadcast";
    this.focusId = null;
    this.candidates = true;
    this.labels = new Map();
    this.ready = new Promise((resolve) => setTimeout(resolve, 250));
    this.resize();
  }
  setCamera(name) {
    if (this.cameraNames.includes(name)) this.cameraName = name;
  }
  nextCamera() {
    const i = this.cameraNames.indexOf(this.cameraName);
    return (this.cameraName = this.cameraNames[(i + 1) % this.cameraNames.length]);
  }
  cameraBasis() {
    return { right: { x: 1, y: 0 }, forward: { x: 0, y: -1 } };
  }
  setCandidatesVisible(on) {
    this.candidates = on;
  }
  setFocus(id) {
    this.focusId = id;
  }
  celebrate() {}
  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.width = innerWidth;
    this.height = innerHeight;
    this.canvas.width = this.width * ratio;
    this.canvas.height = this.height * ratio;
    this.ratio = ratio;
  }
  project(x, y, z = 0) {
    const tactical = this.cameraName === "Tactical";
    const depth = tactical ? 1 : 0.62 + ((y + 34) / 68) * 0.5;
    const scale = (Math.min(this.width / 125, this.height / (tactical ? 84 : 62)) * depth) / (tactical ? 1 : 1.0);
    return [this.width / 2 + x * scale, this.height * (tactical ? 0.5 : 0.5) + y * scale * (tactical ? 1 : 0.62) - z * scale, scale];
  }
  update() {
    const c = this.ctx,
      sim = this.sim;
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const sky = c.createLinearGradient(0, 0, 0, this.height);
    sky.addColorStop(0, "#b9d3ea");
    sky.addColorStop(0.3, "#b7c6d0");
    sky.addColorStop(0.31, "#5d9a4d");
    sky.addColorStop(1, "#3f7f3a");
    c.fillStyle = sky;
    c.fillRect(0, 0, this.width, this.height);
    const quad = (x0, y0, x1, y1) => {
      c.beginPath();
      [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y], i) => {
        const [px, py] = this.project(x, y);
        if (i) c.lineTo(px, py);
        else c.moveTo(px, py);
      });
      c.closePath();
    };
    for (let i = 0; i < 12; i++) {
      quad(-52.5 + i * 8.75, -34, -52.5 + (i + 1) * 8.75, 34);
      c.fillStyle = i % 2 ? "#4f9446" : "#58a04d";
      c.fill();
    }
    c.strokeStyle = "#ffffffd0";
    c.lineWidth = 2;
    quad(-52.5, -34, 52.5, 34);
    c.stroke();
    quad(0, -34, 0, 34);
    c.stroke();
    for (const side of [-1, 1]) {
      quad(side * 52.5, -20.16, side * 36, 20.16);
      c.stroke();
    }
    const focus = sim.player(this.focusId) ?? sim.owner();
    const shown = new Set();
    if (this.candidates && focus?.decision) {
      for (const [id, option] of Object.entries(focus.decision.options)) {
        const [x0, y0] = this.project(focus.x, focus.y),
          [x1, y1] = this.project(option.target.x, option.target.y);
        const selected = id === focus.decision.choice;
        c.strokeStyle = selected ? "#007aff" : option.action === "shoot" ? "#ff5a36cc" : "#35c6f4aa";
        c.lineWidth = selected ? 5 : 3;
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
        c.stroke();
        let label = this.labels.get(id);
        if (!label) {
          label = document.createElement("span");
          this.labels.set(id, label);
          this.labelsEl.append(label);
        }
        label.className = `vector-label${selected ? " selected" : ""}`;
        label.textContent = `${Math.round(focus.decision.probabilities[id] * 100)}%`;
        label.style.transform = `translate(${x1 - 16}px, ${y1 - 26}px)`;
        shown.add(id);
      }
    }
    for (const [id, label] of this.labels)
      if (!shown.has(id)) {
        label.remove();
        this.labels.delete(id);
      }
    for (const p of [...sim.players].sort((a, b) => a.y - b.y)) {
      const [x, y, s] = this.project(p.x, p.y);
      c.fillStyle = "#0000002e";
      c.beginPath();
      c.ellipse(x, y, s * 0.9, s * 0.4, 0, 0, Math.PI * 2);
      c.fill();
      if (p.isHuman) {
        c.strokeStyle = "#ffffff";
        c.lineWidth = 3;
        c.beginPath();
        c.ellipse(x, y, s * 1.6, s * 0.75, 0, 0, Math.PI * 2);
        c.stroke();
      }
      c.fillStyle = p.role === "GK" ? TEAMS[p.team].colors.keeper : TEAMS[p.team].colors.shirt;
      c.fillRect(x - s * 0.45, y - s * 1.9, s * 0.9, s * 1.9);
      c.fillStyle = "#e9c6a5";
      c.beginPath();
      c.arc(x, y - s * 2.2, s * 0.36, 0, Math.PI * 2);
      c.fill();
    }
    const [bx, by, bs] = this.project(sim.ball.x, sim.ball.y, sim.ball.z);
    c.fillStyle = "#fff";
    c.beginPath();
    c.arc(bx, by, Math.max(3, bs * 0.3), 0, Math.PI * 2);
    c.fill();
  }
  dispose() {
    for (const label of this.labels.values()) label.remove();
    this.labels.clear();
  }
}

export class DecisionLoop {
  constructor(sim) {
    this.sim = sim;
    this.configured = false;
    this.enabled = true;
    this.backingOff = false;
    this.lastError = null;
    this.tally = { calls: 0, decisions: 0, jevDecisions: 0, localDecisions: 0, stale: 0, cost: 0, input: 0, output: 0, request_bytes: 0, latencies: [], errors: 0 };
    this.last = null;
    this.seen = 0;
    this.lastCall = 0;
    this.onBatch = () => {};
    this.onError = () => {};
    // Hosted-mode surface of the real loop (docs/AUTH.md); the mock never holds.
    this.held = null;
    this.credits = null;
    this.onAuthRequired = this.onCreditExhausted = this.onCredits = () => {};
  }
  resume() {
    this.held = null;
  }
  tick(now) {
    const sim = this.sim,
      t = this.tally,
      fresh = sim.mockDecisions - this.seen;
    this.seen = sim.mockDecisions;
    sim.mockSource = this.configured && this.enabled ? "jev" : "local";
    t.decisions += fresh;
    if (sim.mockSource !== "jev") {
      t.localDecisions += fresh;
      return;
    }
    t.jevDecisions += fresh;
    if (now - this.lastCall < 250 || !fresh) return;
    this.lastCall = now;
    const latency = Math.round(110 + Math.random() * 240),
      input = Math.round(2400 + Math.random() * 1400);
    t.calls++;
    t.input += input;
    t.request_bytes += input * 3.4;
    t.cost += (input * 0.042) / 1e6;
    t.latencies.push(latency);
    if (t.latencies.length > 240) t.latencies.shift();
    const deciders = sim.players.filter((p) => p.decision && sim.time - p.decision.at < 0.3).slice(0, 10);
    const request = { model: "jev-latest", state: sim.sharedState(), questions: Object.fromEntries(deciders.map((p) => [p.id, { type: "choice", instructions: `You are ${p.id} (${p.role}) for ${TEAMS[p.team].name}. Pick the best action.`, criteria: Object.fromEntries(Object.entries(p.decision.options).map(([id, o]) => [id, o.label])) }])) };
    const response = { model: "jev-latest", source: "jev", decisions: Object.fromEntries(deciders.map((p) => [p.id, { batch_id: p.decision.batchId, choice: p.decision.choice, probabilities: p.decision.probabilities, confidence: p.decision.confidence, source: "jev" }])), usage: { input_tokens: input, output_tokens: 0 }, latency_ms: latency, request_bytes: Math.round(input * 3.4), cost_usd: (input * 0.042) / 1e6, pricing: { input_per_million: 0.042, output_per_million: 0 }, request };
    this.last = { request, response, at: now };
  }
}
