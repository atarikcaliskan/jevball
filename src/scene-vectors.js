import * as THREE from "three";

const STEPS = 24; // resampled points per ribbon body
const MAX_OPTIONS = 14;
const MAX_LABELS = 5;
const MAX_PATH = 40;

// Tactics-board palette (docs/THEME.md): chalk options, orange risk, red shot, floodlight-yellow pick.
const COLORS = {
  pass: new THREE.Color("#f4f1e8"),
  move: new THREE.Color("#f4f1e8"),
  shot: new THREE.Color("#ff4d3d"),
  risky: new THREE.Color("#ff8a3c"),
  selected: new THREE.Color("#ffe14a"),
};
const INK = new THREE.Color("#0a120e");
export const CANDIDATE_MODES = ["all", "selected", "off"];
const PASS_ACTIONS = new Set(["pass", "through", "cross", "clear"]);

function ribbon() {
  const vertices = STEPS * 2 + 3; // body strip + arrowhead triangle
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
  );
  const progress = new Float32Array(vertices),
    edge = new Float32Array(vertices),
    index = [];
  for (let i = 0; i < STEPS; i++) {
    progress[i * 2] = progress[i * 2 + 1] = (i / (STEPS - 1)) * 0.94;
    edge[i * 2] = -1;
    edge[i * 2 + 1] = 1;
  }
  for (let i = 0; i < STEPS - 1; i++) {
    const n = i * 2;
    index.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
  }
  const head = STEPS * 2;
  progress[head] = progress[head + 1] = 0.94;
  progress[head + 2] = 1;
  // Head: |edge| runs 1 → 0 along the slanted sides; the shader renormalises it by head progress.
  edge[head] = -1;
  edge[head + 1] = 1;
  index.push(head, head + 1, head + 2);
  geometry.setAttribute("progress", new THREE.BufferAttribute(progress, 1));
  geometry.setAttribute("edge", new THREE.BufferAttribute(edge, 1));
  geometry.setIndex(index);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tint: { value: new THREE.Color("#ffe14a") },
      ink: { value: INK },
      alpha: { value: 0.3 },
      time: { value: 0 },
      pulse: { value: 0 },
      span: { value: 10 },
      soft: { value: 0 },
      outline: { value: 0 },
      dash: { value: 0 },
    },
    vertexShader: `attribute float progress; attribute float edge; varying float vProgress; varying float vEdge;
      void main() { vProgress = progress; vEdge = edge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 tint; uniform vec3 ink; uniform float alpha; uniform float time; uniform float pulse;
      uniform float span; uniform float soft; uniform float outline; uniform float dash;
      varying float vProgress; varying float vEdge;
      void main() {
        float head = clamp((vProgress - 0.94) / 0.06, 0.0, 1.0);
        float e = min(1.0, abs(vEdge) / max(1.0 - head, 0.02));
        float fade = smoothstep(0.0, 0.08, vProgress) * (0.84 + 0.16 * vProgress);
        float rim = 1.0 - smoothstep(1.0 - max(soft, 0.1), 1.0, e) * (soft > 0.5 ? 1.0 : 0.4);
        float scan = 1.0 - pulse * (0.5 + 0.5 * sin(vProgress * span * 1.35 - time * 7.0));
        // Tactics-board convention: runs are dashed, passes solid. 'dash' is the dash period in metres.
        float gap = dash > 0.0 && head <= 0.0 ? smoothstep(0.3, 0.34, abs(fract(vProgress * span / dash) - 0.5)) : 0.0;
        // A dark ink edge keeps pale chalk legible on sunlit grass.
        float band = outline * smoothstep(0.66, 0.78, e);
        vec3 color = mix(tint + pulse * 0.22 * (1.0 - scan), ink, band);
        float a = mix(alpha * scan, min(1.0, alpha * 1.1) * 0.66, band) * fade * rim * (1.0 - gap);
        gl_FragColor = vec4(color, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  return mesh;
}

function chip(layer, extra = "") {
  const el = document.createElement("span");
  el.className = `vector-label${extra ? ` ${extra}` : ""}`;
  el.hidden = true;
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.whiteSpace = "nowrap";
  el.style.pointerEvents = "none";
  el.style.willChange = "transform";
  layer.append(el);
  return { el, text: "", kind: "", shown: false, x: 0, y: 0 };
}
function setChip(c, text, kind) {
  if (c.text !== text) c.el.textContent = c.text = text;
  if (c.kind !== kind) {
    c.el.className = `vector-label${c.base ? ` ${c.base}` : ""}${kind ? ` ${kind}` : ""}`;
    c.kind = kind;
  }
}
function showChip(c, visible) {
  if (c.shown !== visible) {
    c.el.hidden = !visible;
    c.shown = visible;
  }
}

export class CandidateVectors {
  constructor(scene, layer) {
    this.group = new THREE.Group();
    this.group.name = "candidates";
    scene.add(this.group);
    this.layer = layer;
    this.mode = "all";
    this.focusId = null;
    this.autoId = null;
    this.autoSince = -10;
    this.pool = [];
    for (let i = 0; i < MAX_OPTIONS; i++) {
      const mesh = ribbon();
      this.group.add(mesh);
      this.pool.push(mesh);
    }
    this.glow = ribbon();
    this.glow.renderOrder = 2;
    this.glow.material.uniforms.soft.value = 1;
    this.group.add(this.glow);
    this.labels = [];
    this.tags = null;
    if (layer) {
      for (let i = 0; i < MAX_LABELS; i++) this.labels.push(chip(layer));
      this.tags = {
        focus: chip(layer, "player-tag"),
        you: chip(layer, "player-tag you"),
      };
      this.tags.focus.el.style.zIndex = this.tags.you.el.style.zIndex = "3";
      this.tags.focus.base = "player-tag";
      this.tags.you.base = "player-tag you";
    }
    // Per-decision cache.
    this.items = [];
    this.cacheKey = null;
    this.appear = 0;
    // Scratch.
    this.px = new Float32Array(MAX_PATH);
    this.py = new Float32Array(MAX_PATH);
    this.pz = new Float32Array(MAX_PATH);
    this.cum = new Float32Array(MAX_PATH);
    this.sx = new Float32Array(STEPS + 1);
    this.sy = new Float32Array(STEPS + 1);
    this.sz = new Float32Array(STEPS + 1);
    this.v = new THREE.Vector3();
    this.end = new THREE.Vector3();
    this.offsetX = 0;
    this.offsetY = 0;
  }
  /** "all" every option · "selected" only the pick · "off" nothing (the YOU tag stays). */
  setMode(mode) {
    const wanted = CANDIDATE_MODES.includes(mode) ? mode : "all";
    if (wanted !== this.mode) {
      this.mode = wanted;
      // Clear now, not on the next frame: a paused match must not keep stale ribbons or chips.
      this.hideAll();
      if (this.tags) showChip(this.tags.focus, false);
    }
    return this.mode;
  }
  /** Back-compat: true → "all", false → "selected". */
  setVisible(visible) {
    this.setMode(visible ? "all" : "selected");
  }
  get visible() {
    return this.mode === "all";
  }
  setFocus(id) {
    this.focusId = id || null;
  }
  /** Layer and canvas usually overlap; keep chips right even when they do not. */
  measure(canvas) {
    if (!this.layer) return;
    const a = canvas.getBoundingClientRect(),
      b = this.layer.getBoundingClientRect();
    this.offsetX = a.left - b.left;
    this.offsetY = a.top - b.top;
  }
  resolveFocus(sim) {
    const players = sim.players;
    if (this.focusId) {
      for (let i = 0; i < players.length; i++)
        if (players[i].id === this.focusId) return players[i];
    }
    const ball = sim.ball;
    let wanted = null;
    if (ball?.ownerId) {
      for (let i = 0; i < players.length; i++)
        if (players[i].id === ball.ownerId) wanted = players[i];
      if (wanted && !wanted.decision?.options)
        wanted = wanted.isHuman ? wanted : null;
    }
    if (!wanted && ball?.flight?.fromId && !ball.ownerId) {
      for (let i = 0; i < players.length; i++)
        if (
          players[i].id === ball.flight.fromId &&
          players[i].decision?.options
        )
          wanted = players[i];
      // Only while the kick is still his latest decision; afterwards he is just another runner.
      const action = wanted?.decision.options[wanted.decision.choice]?.action;
      if (wanted && action !== "shoot" && !PASS_ACTIONS.has(action))
        wanted = null;
    }
    let current = null;
    for (let i = 0; i < players.length; i++)
      if (players[i].id === this.autoId) current = players[i];
    if (!wanted) {
      // Most recent decider near the ball, with a little stickiness so focus does not flicker.
      if (
        current?.decision?.options &&
        sim.time - this.autoSince < 0.9 &&
        sim.time >= this.autoSince
      )
        return current;
      let best = -Infinity;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p.decision?.options || !ball) continue;
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d > 28) continue;
        const score = (p.decision.at ?? 0) - d * 0.05;
        if (score > best) {
          best = score;
          wanted = p;
        }
      }
    }
    if (wanted && wanted.id !== this.autoId) {
      this.autoId = wanted.id;
      this.autoSince = sim.time;
    }
    return wanted;
  }
  prepare(player) {
    const decision = player.decision;
    const key = decision;
    if (
      this.cacheKey === key &&
      this.cachePlayer === player.id &&
      this.cacheAt === decision?.at
    )
      return;
    this.cacheAt = decision?.at;
    const fresh = this.cachePlayer !== player.id;
    this.cacheKey = key;
    this.cachePlayer = player.id;
    if (fresh) this.appear = 0;
    this.items.length = 0;
    const options = decision?.options;
    if (!options) return;
    const probabilities = decision.probabilities || {};
    for (const id in options) {
      const option = options[id];
      if (!option?.path || option.path.length < 1) continue;
      const selected = id === decision.choice;
      const f = option.features || {};
      const risky =
        (Number.isFinite(f.success_p) && f.success_p < 0.5) ||
        (Number.isFinite(f.lane_clear_m) && f.lane_clear_m < 2);
      const kind =
        option.action === "shoot"
          ? "shot"
          : risky
            ? "risky"
            : PASS_ACTIONS.has(option.action)
              ? "pass"
              : "move";
      const p = probabilities[id];
      const name = id.replace(/_/g, " ");
      this.items.push({
        id,
        option,
        selected,
        kind,
        probability: Number.isFinite(p) ? p : selected ? 1 : 0,
        text: Number.isFinite(p) ? `${name} · ${Math.round(p * 100)}%` : name,
        labelled: false,
      });
      if (this.items.length >= MAX_OPTIONS) break;
    }
    this.items.sort(
      (a, b) => b.selected - a.selected || b.probability - a.probability,
    );
    for (let i = 0; i < this.items.length; i++)
      this.items[i].labelled =
        i < MAX_LABELS &&
        (this.items[i].selected ||
          Number.isFinite(probabilities[this.items[i].id]));
  }
  /** Resample the option path into sx/sy/sz (STEPS body points + the tip). Returns length in metres. */
  sample(player, path, lift, headLength) {
    const n = Math.min(path.length, MAX_PATH);
    const { px, py, pz, cum, sx, sy, sz } = this;
    for (let i = 0; i < n; i++) {
      px[i] = path[i].x;
      py[i] = (path[i].z || 0) + lift;
      pz[i] = path[i].y;
    }
    // Paths are computed at decision time; re-anchor the tail on the moving player.
    if (n > 1 && Math.hypot(px[0] - player.x, pz[0] - player.y) < 6) {
      px[0] = player.x;
      pz[0] = player.y;
    }
    cum[0] = 0;
    for (let i = 1; i < n; i++)
      cum[i] =
        cum[i - 1] +
        Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]);
    const total = cum[n - 1];
    if (total < 0.75) return total;
    const body = Math.max(total * 0.5, total - headLength);
    let seg = 1;
    for (let i = 0; i <= STEPS; i++) {
      const d = i === STEPS ? total : (i / (STEPS - 1)) * body;
      while (seg < n - 1 && cum[seg] < d) seg++;
      const span = cum[seg] - cum[seg - 1] || 1;
      const t = Math.min(1, Math.max(0, (d - cum[seg - 1]) / span));
      sx[i] = px[seg - 1] + (px[seg] - px[seg - 1]) * t;
      sy[i] = py[seg - 1] + (py[seg] - py[seg - 1]) * t;
      sz[i] = pz[seg - 1] + (pz[seg] - pz[seg - 1]) * t;
    }
    return total;
  }
  write(mesh, halfWidth, headWidth) {
    const a = mesh.geometry.attributes.position;
    const { sx, sy, sz } = this;
    let dx = 1,
      dz = 0;
    for (let i = 0; i < STEPS; i++) {
      const before = Math.max(0, i - 1),
        after = Math.min(STEPS, i + 1);
      const tx = sx[after] - sx[before],
        tz = sz[after] - sz[before],
        len = Math.hypot(tx, tz);
      if (len > 1e-4) {
        dx = tx / len;
        dz = tz / len;
      }
      a.setXYZ(i * 2, sx[i] - dz * halfWidth, sy[i], sz[i] + dx * halfWidth);
      a.setXYZ(
        i * 2 + 1,
        sx[i] + dz * halfWidth,
        sy[i],
        sz[i] - dx * halfWidth,
      );
    }
    const b = STEPS - 1,
      head = STEPS * 2;
    a.setXYZ(head, sx[b] - dz * headWidth, sy[b], sz[b] + dx * headWidth);
    a.setXYZ(head + 1, sx[b] + dz * headWidth, sy[b], sz[b] - dx * headWidth);
    a.setXYZ(head + 2, sx[STEPS], sy[STEPS], sz[STEPS]);
    a.needsUpdate = true;
  }
  project(camera, x, y, z, width, height, out) {
    this.v.set(x, y, z).project(camera);
    out.x = (this.v.x * 0.5 + 0.5) * width + this.offsetX;
    out.y = (-this.v.y * 0.5 + 0.5) * height + this.offsetY;
    return (
      this.v.z > -1 &&
      this.v.z < 1 &&
      Math.abs(this.v.x) < 1.05 &&
      Math.abs(this.v.y) < 1.05
    );
  }
  hideAll() {
    for (const mesh of this.pool) mesh.visible = false;
    this.glow.visible = false;
    for (const label of this.labels) showChip(label, false);
  }
  update(sim, camera, width, height, dt, now) {
    const focus = this.resolveFocus(sim);
    this.focusPlayer = focus;
    this.updateTags(sim, focus, camera, width, height);
    if (this.mode === "off" || !focus?.decision?.options) {
      this.hideAll();
      this.cacheKey = null;
      this.cachePlayer = null;
      return;
    }
    this.prepare(focus);
    this.appear = Math.min(1, this.appear + dt / 0.18);
    const age = sim.time - (focus.decision.at ?? sim.time);
    const stale = 1 - Math.min(1, Math.max(0, (age - 2.2) / 0.8));
    const strength = this.appear * stale;
    const distance = Math.hypot(
      camera.position.x - focus.x,
      camera.position.y,
      camera.position.z - focus.y,
    );
    const scale = Math.min(2.6, Math.max(0.75, distance / 42));
    const all = this.mode === "all";
    let used = 0,
      labelIndex = 0;
    this.glow.visible = false;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const mesh = this.pool[used];
      if (!all && !item.selected) continue;
      const half = (item.selected ? 0.34 : 0.2) * scale;
      const total = this.sample(
        focus,
        item.option.path,
        item.selected ? 0.09 : 0.065,
        1.5 * scale,
      );
      const drawable = total >= 0.75 && strength > 0.01;
      if (drawable) {
        used++;
        mesh.visible = true;
        mesh.renderOrder = item.selected ? 5 : 3;
        this.write(mesh, half, half * 2.7);
        const u = mesh.material.uniforms;
        u.tint.value.copy(item.selected ? COLORS.selected : COLORS[item.kind]);
        const chalk =
          !item.selected && (item.kind === "pass" || item.kind === "move");
        u.alpha.value =
          (item.selected ? (all ? 1 : 0.78) : chalk ? 0.8 : 0.92) * strength;
        u.pulse.value = item.selected ? 0.38 : 0;
        u.outline.value = item.selected ? 0.55 : chalk ? 1 : 0.7;
        u.dash.value = !item.selected && item.kind === "move" ? 2.2 * scale : 0;
        u.time.value = now;
        u.span.value = total;
        if (item.selected) {
          this.glow.visible = true;
          this.write(this.glow, half * 2.6, half * 4.2);
          const g = this.glow.material.uniforms;
          g.tint.value.copy(COLORS.selected);
          g.alpha.value = (all ? 0.26 : 0.16) * strength;
        }
      }
      if (item.labelled && labelIndex < this.labels.length && strength > 0.3) {
        const label = this.labels[labelIndex];
        const n = item.option.path.length - 1;
        const endPoint = item.option.path[n];
        const onScreen = this.project(
          camera,
          endPoint.x,
          (endPoint.z || 0) + 0.9,
          endPoint.y,
          width,
          height,
          label,
        );
        if (onScreen) {
          setChip(
            label,
            item.text,
            item.selected
              ? "selected"
              : item.kind === "shot"
                ? "shot"
                : item.kind === "risky"
                  ? "risky"
                  : "",
          );
          // Greedy de-overlap against chips already placed this frame.
          const tag = this.tags.focus;
          for (let pass = 0; pass < 3; pass++) {
            // Chips sit 1.5 heights above their anchor, tags one height above theirs.
            if (
              tag.shown &&
              Math.abs(tag.x - label.x) < 90 &&
              Math.abs(tag.y - 9 - (label.y - 20)) < 20
            )
              label.y = tag.y - 12;
            for (let k = 0; k < labelIndex; k++) {
              const other = this.labels[k];
              if (
                other.shown &&
                Math.abs(other.x - label.x) < 96 &&
                Math.abs(other.y - label.y) < 19
              )
                label.y = other.y - 20;
            }
          }
          label.el.style.transform = `translate(${label.x.toFixed(1)}px,${label.y.toFixed(1)}px) translate(-50%,-150%)`;
          label.el.style.opacity = item.selected ? "1" : "0.86";
          label.el.style.zIndex = item.selected ? "2" : "1";
          showChip(label, true);
          labelIndex++;
        }
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].visible = false;
    for (let i = labelIndex; i < this.labels.length; i++)
      showChip(this.labels[i], false);
  }
  updateTags(sim, focus, camera, width, height) {
    if (!this.tags) return;
    const { focus: focusTag, you } = this.tags;
    let human = null;
    if (sim.human)
      for (let i = 0; i < sim.players.length; i++)
        if (sim.players[i].id === sim.human.playerId) human = sim.players[i];
    if (
      human &&
      this.project(camera, human.x, 2.02, human.y, width, height, you)
    ) {
      setChip(you, "YOU", "selected");
      you.el.style.transform = `translate(${you.x.toFixed(1)}px,${you.y.toFixed(1)}px) translate(-50%,-100%)`;
      showChip(you, true);
    } else showChip(you, false);
    const wantFocus = focus && focus !== human && this.mode !== "off";
    if (
      wantFocus &&
      this.project(camera, focus.x, 2.02, focus.y, width, height, focusTag)
    ) {
      setChip(focusTag, `${focus.id} · ${focus.role}`, "");
      focusTag.el.style.transform = `translate(${focusTag.x.toFixed(1)}px,${focusTag.y.toFixed(1)}px) translate(-50%,-100%)`;
      showChip(focusTag, true);
    } else showChip(focusTag, false);
  }
  dispose() {
    for (const mesh of [...this.pool, this.glow]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const label of this.labels) label.el.remove();
    if (this.tags) {
      this.tags.focus.el.remove();
      this.tags.you.el.remove();
    }
  }
}
