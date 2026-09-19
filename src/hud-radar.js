// Top-down tactics board. Oriented like the Broadcast camera: +x to the right and
// sim +y toward the bottom of the card (nearer the camera).
const DEFAULT_PITCH = {
  halfL: 52.5,
  halfW: 34,
  goalWidth: 7.32,
  penaltyAreaDepth: 16.5,
  penaltyAreaWidth: 40.32,
  goalAreaDepth: 5.5,
  goalAreaWidth: 18.32,
  centerCircle: 9.15,
  penaltySpot: 11,
};
const MARGIN = 4; // metres of run-off drawn around the touchlines
// Canvas cannot read CSS custom properties cheaply; these mirror src/theme.css.
const INK = {
  ink: "#0a120e",
  runoff: "#0c2014",
  turfA: "#12492a",
  turfB: "#0f4025",
  chalkLine: "#f4f1e8a6",
  magnetEdge: "#f4f1e8d9",
  flood: "#ffe14a",
  shot: "#ff4d3d",
};

export class Radar {
  constructor(canvas, { teams, pitch, onPick }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.teams = teams;
    this.pitch = { ...DEFAULT_PITCH, ...pitch };
    this.onPick = onPick;
    this.sim = null;
    this.events = new AbortController();
    canvas.addEventListener("click", (event) => this.pick(event), {
      signal: this.events.signal,
    });
    canvas.addEventListener("pointermove", (event) => this.hover(event), {
      signal: this.events.signal,
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }
  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = this.canvas.clientWidth || 240;
    const span = this.pitch.halfL * 2 + MARGIN * 2;
    const height = Math.round(
      (width * (this.pitch.halfW * 2 + MARGIN * 2)) / span,
    );
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.view = { width, height, ratio, scale: width / span };
    this.dirty = true;
  }
  toCanvas(x, y) {
    const { width, height, scale } = this.view;
    return [width / 2 + x * scale, height / 2 + y * scale];
  }
  toSim(event) {
    const rect = this.canvas.getBoundingClientRect();
    const { scale } = this.view;
    return {
      x: (event.clientX - rect.left - rect.width / 2) / scale,
      y: (event.clientY - rect.top - rect.height / 2) / scale,
    };
  }
  nearest(event) {
    if (!this.sim) return null;
    const at = this.toSim(event);
    // Generous hit radius: dots are small, thumbs and cursors are not.
    const reach = Math.max(3.2, 9 / this.view.scale);
    let best = null,
      bestDistance = reach;
    for (const p of this.sim.players) {
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    return best;
  }
  pick(event) {
    this.onPick?.(this.nearest(event)?.id ?? null);
  }
  hover(event) {
    if (event.pointerType === "touch") return;
    this.canvas.style.cursor = this.nearest(event) ? "pointer" : "default";
  }
  draw(sim, focusId, now = 0) {
    this.sim = sim;
    const c = this.ctx,
      P = this.pitch,
      { width, height, ratio, scale } = this.view;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, width, height);
    // Tactics board: dark turf, mowing stripes, chalk markings.
    c.fillStyle = INK.runoff;
    c.fillRect(0, 0, width, height);
    const [left, top] = this.toCanvas(-P.halfL, -P.halfW);
    const pw = P.halfL * 2 * scale,
      ph = P.halfW * 2 * scale;
    const STRIPES = 12;
    for (let i = 0; i < STRIPES; i++) {
      c.fillStyle = i % 2 ? INK.turfB : INK.turfA;
      c.fillRect(left + (pw / STRIPES) * i, top, pw / STRIPES + 0.5, ph);
    }
    // Goals tinted by the team defending them (sides swap at half-time).
    for (const side of [-1, 1]) {
      const defender = [0, 1].find((t) => sim.attackDir(t) === -side) ?? 0;
      const [gx, gy] = this.toCanvas(side * P.halfL, -P.goalWidth / 2);
      c.fillStyle = this.teams[defender].colors.shirt;
      c.fillRect(side < 0 ? gx - 4 : gx, gy, 4, P.goalWidth * scale);
    }
    c.strokeStyle = INK.chalkLine;
    c.lineWidth = 1;
    c.strokeRect(left + 0.5, top + 0.5, pw - 1, ph - 1);
    c.beginPath();
    c.moveTo(width / 2, top);
    c.lineTo(width / 2, top + ph);
    c.moveTo(width / 2 + P.centerCircle * scale, height / 2);
    c.arc(width / 2, height / 2, P.centerCircle * scale, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = INK.chalkLine;
    c.beginPath();
    c.arc(width / 2, height / 2, 1.4, 0, Math.PI * 2);
    c.fill();
    for (const side of [-1, 1]) {
      const box = (depth, across) => {
        const [x, y] = this.toCanvas(
          side < 0 ? -P.halfL : P.halfL - depth,
          -across / 2,
        );
        c.strokeRect(x, y, depth * scale, across * scale);
      };
      box(P.penaltyAreaDepth, P.penaltyAreaWidth);
      box(P.goalAreaDepth, P.goalAreaWidth);
      // Penalty spot and the "D".
      const [sx, sy] = this.toCanvas(side * (P.halfL - P.penaltySpot), 0);
      c.beginPath();
      c.arc(sx, sy, 1.1, 0, Math.PI * 2);
      c.fill();
      const reach = Math.acos(
        (P.penaltyAreaDepth - P.penaltySpot) / P.centerCircle,
      );
      c.beginPath();
      if (side < 0) c.arc(sx, sy, P.centerCircle * scale, -reach, reach);
      else c.arc(sx, sy, P.centerCircle * scale, Math.PI - reach, Math.PI + reach);
      c.stroke();
      // Corner arcs.
      for (const edge of [-1, 1]) {
        const [cx, cy] = this.toCanvas(side * P.halfL, edge * P.halfW);
        const from = Math.atan2(-edge, -side);
        c.beginPath();
        c.arc(cx, cy, Math.max(3, 1.6 * scale), from - Math.PI / 4, from + Math.PI / 4);
        c.stroke();
      }
    }

    const focus = focusId ? sim.player(focusId) : null;
    // The focused player's selected option: a dashed chalk arrow in floodlight yellow.
    const chosen = focus?.decision?.options?.[focus.decision.choice];
    const target = chosen?.target ?? focus?.intent?.target;
    if (focus && target && Number.isFinite(target.x)) {
      const path = (chosen?.path?.length > 1 ? chosen.path : [focus, target]).map(
        (point) => this.toCanvas(point.x, point.y),
      );
      c.strokeStyle = INK.flood;
      c.fillStyle = INK.flood;
      c.lineWidth = 1.8;
      c.lineCap = "round";
      c.setLineDash([5, 4]);
      c.lineDashOffset = -(now / 60) % 9;
      c.beginPath();
      path.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
      c.setLineDash([]);
      const [tx, ty] = path.at(-1);
      // Direction from a point a little way back, so curved paths still aim well.
      let [fx, fy] = path[0];
      for (let i = path.length - 2; i >= 0; i--) {
        [fx, fy] = path[i];
        if (Math.hypot(tx - fx, ty - fy) > 6) break;
      }
      const heading = Math.atan2(ty - fy, tx - fx);
      if (Math.hypot(tx - fx, ty - fy) > 3) {
        c.beginPath();
        c.moveTo(tx + Math.cos(heading) * 4, ty + Math.sin(heading) * 4);
        c.lineTo(tx + Math.cos(heading + 2.5) * 6, ty + Math.sin(heading + 2.5) * 6);
        c.lineTo(tx + Math.cos(heading - 2.5) * 6, ty + Math.sin(heading - 2.5) * 6);
        c.closePath();
        c.fill();
      } else {
        // Staying put (hold, set): chalk "X marks the spot".
        c.beginPath();
        c.moveTo(tx - 3.5, ty - 3.5);
        c.lineTo(tx + 3.5, ty + 3.5);
        c.moveTo(tx + 3.5, ty - 3.5);
        c.lineTo(tx - 3.5, ty + 3.5);
        c.stroke();
      }
    }

    // Numbered magnets, like a coach's board.
    const radius = Math.max(4.2, Math.min(7, scale * 2.35));
    const numbered = radius >= 5.2;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `700 ${Math.round(radius * 1.25)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    // Focused and human players are drawn last so they sit on top.
    const order = [...sim.players].sort(
      (a, b) => (a === focus || a.isHuman ? 1 : 0) - (b === focus || b.isHuman ? 1 : 0),
    );
    for (const p of order) {
      const [x, y] = this.toCanvas(p.x, p.y);
      const colors = this.teams[p.team].colors;
      const keeper = p.role === "GK";
      if (p.isHuman) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 260);
        c.strokeStyle = INK.shot;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, radius + 3 + pulse * 2, 0, Math.PI * 2);
        c.stroke();
      }
      if (focus === p) {
        c.fillStyle = "#ffe14a38";
        c.beginPath();
        c.arc(x, y, radius + 5, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = INK.flood;
        c.lineWidth = 1.6;
        c.stroke();
      }
      c.fillStyle = keeper ? colors.keeper : colors.shirt;
      c.beginPath();
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = keeper ? colors.shirt : INK.magnetEdge;
      c.stroke();
      if (numbered) {
        c.fillStyle = keeper ? INK.ink : "#ffffff";
        c.fillText(String(p.number), x, y + 0.5);
      }
    }

    const [bx, by] = this.toCanvas(sim.ball.x, sim.ball.y);
    const lift = Math.min(3, (sim.ball.z || 0) * 0.35);
    c.fillStyle = "#ffffff";
    c.strokeStyle = INK.ink;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(bx, by - lift, 2.8 + lift * 0.3, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
  dispose() {
    this.events.abort();
    this.observer.disconnect();
  }
}
