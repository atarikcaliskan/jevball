import * as THREE from "three";
import { PITCH } from "./pitch.js";
import { BOWL } from "./scene-stadium.js";

export const CAMERA_NAMES = [
  "Broadcast",
  "Tactical",
  "Follow",
  "Behind goal",
  "Cinematic",
];

const LIMITS = {
  Broadcast: {
    yaw: 0.55,
    pitchMin: -0.14,
    pitchMax: 0.5,
    zoomMin: 0.45,
    zoomMax: 1.25,
  },
  Tactical: {
    yaw: Math.PI,
    pitchMin: -0.38,
    pitchMax: 0.12,
    zoomMin: 0.4,
    zoomMax: 1.15,
  },
  Follow: {
    yaw: Math.PI,
    pitchMin: -0.3,
    pitchMax: 0.9,
    zoomMin: 0.45,
    zoomMax: 2.6,
  },
  "Behind goal": {
    yaw: 0.6,
    pitchMin: -0.1,
    pitchMax: 0.5,
    zoomMin: 0.4,
    zoomMax: 1.3,
  },
  Cinematic: {
    yaw: Math.PI,
    pitchMin: -0.12,
    pitchMax: 0.45,
    zoomMin: 0.5,
    zoomMax: 1.35,
  },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Drag to orbit, wheel / pinch to zoom, double-click to reset. State is kept per camera. */
export class CameraInput {
  constructor(canvas, getName) {
    this.canvas = canvas;
    this.getName = getName;
    this.reset();
    this.pointers = new Map();
    this.pinch = 0;
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    const on = (type, handler, options) => {
      canvas.addEventListener(type, handler, options);
      this.off.push(() => canvas.removeEventListener(type, handler, options));
    };
    this.off = [];
    on("pointerdown", (event) => {
      if (
        event.button !== 0 &&
        event.button !== 2 &&
        event.pointerType === "mouse"
      )
        return;
      this.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = "grabbing";
      this.pinch = 0;
    });
    on("pointermove", (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) return;
      const dx = event.clientX - pointer.x,
        dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const name = this.getName(),
        state = this.states[name],
        limit = LIMITS[name];
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch)
          state.zoom = clamp(
            (state.zoom * this.pinch) / Math.max(gap, 1),
            limit.zoomMin,
            limit.zoomMax,
          );
        this.pinch = gap;
        return;
      }
      state.yaw =
        limit.yaw >= Math.PI
          ? state.yaw - dx * 0.005
          : clamp(state.yaw - dx * 0.004, -limit.yaw, limit.yaw);
      state.pitch = clamp(
        state.pitch + dy * 0.004,
        limit.pitchMin,
        limit.pitchMax,
      );
    });
    const release = (event) => {
      this.pointers.delete(event.pointerId);
      this.pinch = 0;
      if (!this.pointers.size) canvas.style.cursor = "grab";
    };
    on("pointerup", release);
    on("pointercancel", release);
    on("lostpointercapture", release);
    on("contextmenu", (event) => event.preventDefault());
    on(
      "wheel",
      (event) => {
        event.preventDefault();
        const name = this.getName(),
          state = this.states[name],
          limit = LIMITS[name];
        state.zoom = clamp(
          state.zoom * Math.exp(event.deltaY * 0.001),
          limit.zoomMin,
          limit.zoomMax,
        );
      },
      { passive: false },
    );
    on("dblclick", () => this.reset(this.getName()));
  }
  reset(name) {
    if (!this.states || !name) {
      this.states = {};
      for (const key of CAMERA_NAMES)
        this.states[key] = { yaw: 0, pitch: 0, zoom: 1 };
    } else Object.assign(this.states[name], { yaw: 0, pitch: 0, zoom: 1 });
  }
  dispose() {
    for (const off of this.off) off();
  }
}

export class CameraRig {
  constructor(camera, canvas) {
    this.camera = camera;
    this.name = CAMERA_NAMES[0];
    this.input = new CameraInput(canvas, () => this.name);
    this.position = new THREE.Vector3(0, 30, 70);
    this.target = new THREE.Vector3();
    this.fov = 30;
    this.wantPosition = new THREE.Vector3();
    this.wantTarget = new THREE.Vector3();
    this.offset = new THREE.Vector3();
    this.spherical = new THREE.Spherical();
    this.ball = new THREE.Vector3();
    this.followYaw = 0;
    this.cine = { time: 0, target: new THREE.Vector3(), primed: false };
    this.end = 1;
    this.snap = true;
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.basis = { right: { x: 1, y: 0 }, forward: { x: 0, y: -1 } };
  }
  set(name) {
    if (CAMERA_NAMES.includes(name)) this.name = name;
    return this.name;
  }
  next() {
    this.name =
      CAMERA_NAMES[(CAMERA_NAMES.indexOf(this.name) + 1) % CAMERA_NAMES.length];
    return this.name;
  }
  subject(sim) {
    const players = sim.players;
    if (sim.human)
      for (let i = 0; i < players.length; i++)
        if (players[i].id === sim.human.playerId) return players[i];
    const owner = sim.ball?.ownerId;
    if (owner)
      for (let i = 0; i < players.length; i++)
        if (players[i].id === owner) return players[i];
    return null;
  }
  update(sim, dt) {
    const step = Math.min(dt, 0.1);
    const b = sim.ball || { x: 0, y: 0, z: 0 };
    // A calmer ball proxy: TV operators do not follow every bounce.
    const kBall = this.snap ? 1 : 1 - Math.exp(-step * 3.2);
    this.ball.x += (b.x - this.ball.x) * kBall;
    this.ball.y += (Math.min(b.z || 0, 6) - this.ball.y) * kBall;
    this.ball.z += (b.y - this.ball.z) * kBall;
    const bx = clamp(this.ball.x, -PITCH.halfL, PITCH.halfL),
      bz = clamp(this.ball.z, -PITCH.halfW, PITCH.halfW);
    let fov = 30;
    const P = this.wantPosition,
      T = this.wantTarget;
    if (this.name === "Broadcast") {
      // High gantry at the lip of the roof opening: no canopy above it, so it can sit above roof level.
      P.set(bx * 0.42, 31, BOWL.halfZ + 5.4);
      // Aim a touch beyond the ball so it sits just below the middle of the frame, like TV;
      // follow harder on the near side, where the view gets steep and the ball would slip out below.
      const near = clamp(bz / PITCH.halfW, 0, 1);
      T.set(bx * 0.9, 0.6, bz * (0.7 + 0.4 * near) - 3);
      // Tighter when play is on the far side, wider near the camera.
      fov = 34 + (bz / PITCH.halfW) * 3 - Math.abs(bx / PITCH.halfL) * 2;
    } else if (this.name === "Tactical") {
      P.set(0, 112, 34);
      T.set(0, 0, 5);
      fov = 42;
    } else if (this.name === "Follow") {
      const subject = this.subject(sim);
      const team = subject ? subject.team : (sim.possession ?? 0);
      const dir =
        typeof sim.attackDir === "function"
          ? sim.attackDir(team)
          : team === 0
            ? 1
            : -1;
      const wantYaw = dir > 0 ? 0 : Math.PI;
      let delta = (wantYaw - this.followYaw) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.followYaw += delta * (this.snap ? 1 : 1 - Math.exp(-step * 2.2));
      const sx = subject ? subject.x : this.ball.x,
        sz = subject ? subject.y : this.ball.z;
      const cx = Math.cos(this.followYaw),
        cz = Math.sin(this.followYaw);
      // Look a little toward the ball so it stays in frame.
      const lx = sx + cx * 7 + (this.ball.x - sx) * 0.25,
        lz = sz + cz * 7 + (this.ball.z - sz) * 0.25;
      P.set(sx - cx * 15, 7.2, sz - cz * 15);
      T.set(lx, 1.1, lz);
      fov = 44;
    } else if (this.name === "Cinematic") {
      fov = this.cinematic(step, bx, bz, P, T);
    } else {
      if (this.ball.x > 9) this.end = 1;
      else if (this.ball.x < -9) this.end = -1;
      P.set(this.end * (PITCH.halfL + 13), 8, bz * 0.1);
      T.set(this.end * 35 + (bx - this.end * 35) * 0.3, 0.5, bz * 0.55);
      fov = 41 - Math.abs(bx - this.end * PITCH.halfL) * 0.06;
    }

    // User orbit around the target.
    const state = this.input.states[this.name];
    this.offset.copy(P).sub(T);
    this.spherical.setFromVector3(this.offset);
    this.spherical.theta += state.yaw;
    this.spherical.phi = clamp(
      this.spherical.phi - state.pitch,
      0.06,
      Math.PI / 2 - 0.035,
    );
    if (this.name === "Follow") this.spherical.radius *= state.zoom;
    else fov = clamp(fov * state.zoom, 8, 62);
    P.setFromSpherical(this.spherical).add(T);
    // The drifting camera wanders over the stands; keep it under roof level so the canopy rule applies.
    if (this.name === "Cinematic") P.y = Math.min(P.y, 26);
    this.constrain(P);

    const rate =
      this.name === "Follow" ? 4.2 : this.name === "Cinematic" ? 1.5 : 3.4;
    const k = this.snap ? 1 : 1 - Math.exp(-step * rate);
    this.position.lerp(P, k);
    this.target.lerp(T, k);
    this.fov += (fov - this.fov) * k;
    this.snap = false;
    // Smoothing cuts corners across the seating; re-check the eased position too.
    if (this.name === "Cinematic") this.constrain(this.position);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
  /**
   * Slow crane drift: the camera rides an ellipse just inside the advertising boards, a third of the
   * way toward the (heavily damped) ball, breathing in and out. Returns the wanted fov.
   */
  cinematic(step, bx, bz, P, T) {
    const c = this.cine;
    c.time += step;
    if (!c.primed) {
      c.target.set(bx, 1, bz);
      c.primed = true;
    } else {
      // Heavy damping, but hurry once the ball threatens to leave the frame (long passes, clearances).
      const error = Math.hypot(bx - c.target.x, bz - c.target.z);
      const k = 1 - Math.exp(-step * (0.8 + Math.max(0, error - 9) * 0.14));
      c.target.x += (bx - c.target.x) * k;
      c.target.z += (bz - c.target.z) * k;
    }
    const t = c.time;
    const theta = 0.55 + t * 0.05; // one lap ≈ 2 min
    const breathe = 1 + 0.1 * Math.sin(t * 0.083 + 0.6);
    T.copy(c.target);
    P.set(
      c.target.x * 0.5 + Math.sin(theta) * 44 * breathe,
      0,
      c.target.z * 0.5 + Math.cos(theta) * 31 * breathe,
    );
    // Never hover right above the play: keep a minimum ground distance to the target.
    let dx = P.x - T.x,
      dz = P.z - T.z,
      ground = Math.hypot(dx, dz);
    const near = 27;
    if (ground < near) {
      if (ground < 1e-3) {
        dx = Math.sin(theta);
        dz = Math.cos(theta);
        ground = 1;
      }
      P.x = T.x + (dx / ground) * near;
      P.z = T.z + (dz / ground) * near;
      ground = near;
    }
    // Low broadcast height, craning up for long shots so the frame is pitch rather than stands.
    P.y =
      10.5 + 2.4 * Math.sin(t * 0.061 + 1.2) + Math.max(0, ground - 38) * 0.24;
    // Hold the subject size (a ~23 m tall window at the ball) whatever the distance, plus a gentle zoom breath.
    const distance = Math.hypot(ground, P.y - T.y);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(11.5 / distance));
    return clamp(fov, 12, 36) * (1 + 0.07 * Math.sin(t * 0.11));
  }
  /** Keep low cameras inside the bowl: above the seats, below the canopy, never through a wall. */
  constrain(P) {
    P.y = Math.max(P.y, 1.2);
    if (P.y > 45) return;
    const limit = BOWL.depth - 3;
    let d = Math.max(Math.abs(P.x) - BOWL.halfX, Math.abs(P.z) - BOWL.halfZ);
    if (d > limit) {
      P.x = clamp(P.x, -(BOWL.halfX + limit), BOWL.halfX + limit);
      P.z = clamp(P.z, -(BOWL.halfZ + limit), BOWL.halfZ + limit);
      d = limit;
    }
    if (d <= 0) return;
    // Lower tier, the wall up to the second tier (eased into a ramp so a gliding camera never pops), upper tier.
    const seats =
      d < 11.9
        ? Math.max(1.3 + d * 0.5, 9.6 - (11.9 - d) * 1.2)
        : d < 13.4
          ? 9.6
          : 9.6 + (d - 13.4) * 0.7;
    P.y = Math.max(P.y, seats + 2.4);
    if (d > BOWL.roofInner - 2) {
      const canopy =
        BOWL.roofHeight - Math.max(0, d - BOWL.roofInner) * 0.136 - 1.6;
      P.y = Math.min(P.y, canopy);
    }
  }
  /** Screen-right and screen-up projected on the pitch, as unit vectors in SIM coordinates. */
  cameraBasis() {
    const e = this.camera.matrixWorld.elements;
    this.right.set(e[0], 0, e[2]);
    // up + forward share the same ground heading; the sum stays stable for top-down views.
    this.forward.set(e[4] - e[8], 0, e[6] - e[10]);
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.right.normalize();
    this.forward.normalize();
    this.basis.right.x = this.right.x;
    this.basis.right.y = this.right.z;
    this.basis.forward.x = this.forward.x;
    this.basis.forward.y = this.forward.z;
    return this.basis;
  }
  dispose() {
    this.input.dispose();
  }
}
