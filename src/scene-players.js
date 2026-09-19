import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TEAMS } from "./pitch.js";
import { FONT, canvasTexture, paint, painted } from "./materials.js";

const HIP = 0.92;
const SKINS = ["#f0c8a4", "#e0ac84", "#c68e62", "#8d5a3a", "#5e3a24"];
const HAIRS = [
  "#1b1612",
  "#2e2118",
  "#5a3b22",
  "#b08a4e",
  "#15110e",
  "#3a3a3d",
];
const BOOTS = ["#15171b", "#f4f5f6", "#15171b", "#d8ff3e", "#ff5a36"];
const KICK_SECONDS = 0.35;
const TAU = Math.PI * 2;

const cache = new Map();
function cached(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}
const merge = (parts) => {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
};
function lathe(profile, sx, sz, color, segments = 16) {
  const g = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return paint(g, color);
}

// All segment geometries are authored around their joint so a rig is just nested pivots.
function torsoGeometry(shirt, shorts, trim) {
  return cached(`torso:${shirt}:${shorts}:${trim}`, () =>
    merge([
      lathe(
        [
          [0, 0.02],
          [0.148, 0.02],
          [0.156, 0.08],
          [0.149, 0.2],
          [0.17, 0.36],
          [0.177, 0.46],
          [0.152, 0.535],
          [0.07, 0.578],
          [0, 0.58],
        ],
        1.13,
        0.67,
        shirt,
      ),
      lathe(
        [
          [0.071, 0.566],
          [0.079, 0.578],
          [0.071, 0.592],
        ],
        1.1,
        0.8,
        trim,
        12,
      ),
      lathe(
        [
          [0, -0.11],
          [0.125, -0.11],
          [0.166, -0.05],
          [0.17, 0.05],
          [0.158, 0.115],
          [0, 0.12],
        ],
        1.1,
        0.74,
        shorts,
      ),
    ]),
  );
}
function headGeometry(skin, hair, style) {
  return cached(`head:${skin}:${hair}:${style}`, () => {
    const parts = [
      paint(
        new THREE.CylinderGeometry(0.047, 0.055, 0.12, 10).translate(
          0,
          0.05,
          0,
        ),
        skin,
      ),
      paint(
        new THREE.SphereGeometry(0.104, 18, 14)
          .scale(0.94, 1.17, 1.02)
          .translate(0, 0.195, 0.008),
        skin,
      ),
      paint(
        new THREE.SphereGeometry(0.02, 6, 5)
          .scale(0.8, 1.1, 1)
          .translate(0, 0.185, 0.112),
        skin,
      ),
      paint(
        new THREE.SphereGeometry(0.0125, 6, 5).translate(-0.036, 0.215, 0.096),
        "#1a1512",
      ),
      paint(
        new THREE.SphereGeometry(0.0125, 6, 5).translate(0.036, 0.215, 0.096),
        "#1a1512",
      ),
      paint(
        new THREE.BoxGeometry(0.036, 0.007, 0.01).translate(0, 0.148, 0.103),
        "#7a3f35",
      ),
    ];
    if (style !== 2)
      parts.push(
        paint(
          new THREE.SphereGeometry(
            0.111,
            18,
            10,
            0,
            TAU,
            0,
            Math.PI * (style ? 0.5 : 0.58),
          )
            .scale(0.95, 1.17, 1.04)
            .rotateX(-0.42)
            .translate(0, 0.2, 0.002),
          hair,
        ),
      );
    else
      parts.push(
        paint(
          new THREE.SphereGeometry(0.107, 18, 8, 0, TAU, 0, Math.PI * 0.42)
            .scale(0.95, 1.17, 1.03)
            .rotateX(-0.3)
            .translate(0, 0.198, 0.004),
          hair,
        ),
      );
    return merge(parts);
  });
}
function upperArmGeometry(shirt, skin, longSleeve) {
  return cached(`uarm:${shirt}:${skin}:${longSleeve}`, () =>
    merge([
      paint(
        new THREE.SphereGeometry(0.056, 12, 10).translate(0, -0.012, 0),
        shirt,
      ),
      paint(
        new THREE.CapsuleGeometry(
          0.051,
          longSleeve ? 0.2 : 0.09,
          4,
          10,
        ).translate(0, longSleeve ? -0.13 : -0.075, 0),
        shirt,
      ),
      paint(
        new THREE.CapsuleGeometry(0.044, 0.2, 4, 10).translate(0, -0.14, 0),
        longSleeve ? shirt : skin,
      ),
    ]),
  );
}
function forearmGeometry(skin, sleeve, glove) {
  return cached(`farm:${skin}:${sleeve}:${glove}`, () =>
    merge([
      paint(
        new THREE.CapsuleGeometry(sleeve ? 0.044 : 0.038, 0.2, 4, 10).translate(
          0,
          -0.12,
          0,
        ),
        sleeve || skin,
      ),
      paint(
        new THREE.SphereGeometry(glove ? 0.06 : 0.042, 10, 8)
          .scale(0.8, 1.25, 1)
          .translate(0, -0.285, 0),
        glove || skin,
      ),
    ]),
  );
}
function thighGeometry(shorts, skin) {
  return cached(`thigh:${shorts}:${skin}`, () =>
    merge([
      paint(
        new THREE.CapsuleGeometry(0.07, 0.31, 4, 12).translate(0, -0.215, 0),
        skin,
      ),
      paint(
        new THREE.CylinderGeometry(0.086, 0.097, 0.25, 12, 1, true).translate(
          0,
          -0.105,
          0,
        ),
        shorts,
      ),
    ]),
  );
}
function shinGeometry(socks, boot, skin) {
  return cached(`shin:${socks}:${boot}:${skin}`, () =>
    merge([
      paint(new THREE.SphereGeometry(0.06, 10, 8).translate(0, 0, 0.004), skin),
      paint(
        new THREE.CapsuleGeometry(0.05, 0.27, 4, 10)
          .scale(1, 1, 1.12)
          .translate(0, -0.2, -0.004),
        socks,
      ),
      paint(
        new THREE.CapsuleGeometry(0.047, 0.15, 4, 10)
          .rotateX(Math.PI / 2)
          .scale(1.05, 0.82, 1)
          .translate(0, -0.438, 0.052),
        boot,
      ),
    ]),
  );
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function luminance(hex) {
  const c = new THREE.Color(hex);
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

class Rig {
  constructor(player, material) {
    const team = TEAMS[player.team] || TEAMS[0];
    const keeper = player.role === "GK";
    const h = hash(player.id);
    const skin = SKINS[h % SKINS.length],
      hair = HAIRS[(h >>> 4) % HAIRS.length],
      style = (h >>> 9) % 3,
      boot = BOOTS[(h >>> 12) % BOOTS.length];
    const shirt = keeper ? team.colors.keeper : team.colors.shirt;
    const shorts = keeper ? "#1d2026" : team.colors.shorts;
    const socks = keeper ? team.colors.keeper : team.colors.socks;
    const trim = luminance(shirt) > 0.45 ? "#171a20" : "#ffffff";
    this.id = player.id;
    this.seed = (h % 1000) / 1000;
    this.root = new THREE.Group();
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = HIP;
    this.upper = new THREE.Group();
    this.root.add(this.pelvis);
    this.pelvis.add(this.upper);
    const mesh = (geometry, parent, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    mesh(torsoGeometry(shirt, shorts, trim), this.upper);
    this.head = mesh(headGeometry(skin, hair, style), this.upper, 0, 0.575, 0);
    this.arms = [];
    this.legs = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.212, 0.5, 0);
      mesh(upperArmGeometry(shirt, skin, keeper), arm);
      const fore = new THREE.Group();
      fore.position.y = -0.27;
      mesh(
        forearmGeometry(skin, keeper ? shirt : null, keeper ? "#f4f5f6" : null),
        fore,
      );
      arm.add(fore);
      this.upper.add(arm);
      this.arms.push({ arm, fore, side });
      const leg = new THREE.Group();
      leg.position.set(side * 0.093, -0.02, 0);
      mesh(thighGeometry(shorts, skin), leg);
      const shin = new THREE.Group();
      shin.position.y = -0.44;
      mesh(shinGeometry(socks, boot, skin), shin);
      leg.add(shin);
      this.pelvis.add(leg);
      this.legs.push({ leg, shin, side });
    }
    // Shirt number on the back.
    const ink = luminance(shirt) > 0.45 ? "#171a20" : "#ffffff";
    this.numberTexture = canvasTexture(64, 64, (ctx) => {
      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `700 ${player.number > 9 ? 52 : 58}px ${FONT}`;
      ctx.fillText(String(player.number), 32, 35);
    });
    this.numberMaterial = new THREE.MeshStandardMaterial({
      map: this.numberTexture,
      alphaTest: 0.45,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const number = new THREE.Mesh(Rig.numberGeometry(), this.numberMaterial);
    number.position.set(0, 0.35, -0.117);
    this.upper.add(number);
    this.phase = this.seed * TAU;
    this.facing = null;
    this.lean = 0;
    this.lastSpeed = 0;
    this.accel = 0;
    this.gkReady = 0;
    this.gkReach = 0;
  }
  static numberGeometry() {
    return cached("number", () =>
      new THREE.PlaneGeometry(0.21, 0.21).rotateY(Math.PI).rotateX(-0.05),
    );
  }
  dispose() {
    this.numberTexture.dispose();
    this.numberMaterial.dispose();
  }
}

function dampAngle(current, target, k) {
  let delta = (target - current) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return current + delta * k;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Players {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = "players";
    scene.add(this.group);
    this.material = painted("player", { roughness: 0.72 });
    this.rigs = new Map();
    const ringMaterial = (color, opacity) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
    this.humanRing = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.8, 48).rotateX(-Math.PI / 2),
      ringMaterial("#ffe14a", 0.95), // floodlight yellow: red would vanish under the home kit
    );
    this.humanGlow = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.15, 48).rotateX(-Math.PI / 2),
      ringMaterial("#ffe14a", 0.3),
    );
    this.carrierRing = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.53, 40).rotateX(-Math.PI / 2),
      ringMaterial("#f4f1e8", 0.9), // chalk
    );
    // Team-coloured discs under everyone, only faded in for high cameras where bodies get tiny.
    this.discs = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.62, 1.12, 28).rotateX(-Math.PI / 2),
      ringMaterial("#ffffff", 0),
      22,
    );
    this.discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.discs.frustumCulled = false;
    this.discs.renderOrder = 4;
    this.discs.visible = false;
    this.group.add(this.discs);
    this.discMatrix = new THREE.Matrix4();
    this.discColor = new THREE.Color();
    this.discColored = "";
    for (const ring of [this.humanRing, this.humanGlow, this.carrierRing]) {
      ring.position.y = 0.035;
      ring.renderOrder = 4;
      ring.visible = false;
      this.group.add(ring);
    }
  }
  rig(player) {
    let rig = this.rigs.get(player.id);
    if (!rig) {
      rig = new Rig(player, this.material);
      this.rigs.set(player.id, rig);
      this.group.add(rig.root);
    }
    return rig;
  }
  redrawText() {
    for (const rig of this.rigs.values()) rig.numberTexture.userData.redraw();
  }
  updateDiscs(sim, camera) {
    const high = smoothstep(42, 95, camera.position.y);
    this.discs.visible = high > 0.02;
    if (!this.discs.visible) return;
    this.discs.material.opacity = 0.85 * high;
    const count = Math.min(22, sim.players.length);
    this.discs.count = count;
    for (let i = 0; i < count; i++) {
      const p = sim.players[i];
      this.discMatrix.makeScale(1.25, 1, 1.25).setPosition(p.x, 0.03, p.y);
      this.discs.setMatrixAt(i, this.discMatrix);
    }
    this.discs.instanceMatrix.needsUpdate = true;
    if (this.discColored !== sim.players) {
      this.discColored = sim.players;
      for (let i = 0; i < count; i++) {
        const p = sim.players[i];
        const colors = TEAMS[p.team]?.colors;
        this.discs.setColorAt(
          i,
          this.discColor.set(
            (p.role === "GK" ? colors?.keeper : colors?.shirt) || "#ffffff",
          ),
        );
      }
      this.discs.instanceColor.needsUpdate = true;
    }
  }
  update(sim, dt, now, camera) {
    if (camera) this.updateDiscs(sim, camera);
    const ball = sim.ball;
    const step = Math.min(dt, 0.1);
    for (const p of sim.players) {
      const rig = this.rig(p);
      const speed = Number.isFinite(p.speed)
        ? p.speed
        : Math.hypot(p.vx || 0, p.vy || 0);
      rig.root.position.set(p.x, 0, p.y);
      const facing = Number.isFinite(p.facing)
        ? p.facing
        : Math.atan2(p.vy || 0, p.vx || 1);
      rig.facing =
        rig.facing === null
          ? facing
          : dampAngle(rig.facing, facing, 1 - Math.exp(-step * 11));
      rig.root.rotation.y = Math.PI / 2 - rig.facing;

      const s = Math.min(1, speed / 7.5);
      const moving = smoothstep(0.15, 1.1, speed);
      rig.phase =
        (rig.phase + step * TAU * (1.0 + 0.155 * speed) * moving) % TAU;
      if (step > 0) {
        const a = (speed - rig.lastSpeed) / step;
        rig.accel +=
          (Math.max(-8, Math.min(8, a)) - rig.accel) *
          (1 - Math.exp(-step * 6));
      }
      rig.lastSpeed = speed;
      const leanTarget =
        0.03 + 0.2 * s + Math.max(-0.16, Math.min(0.24, rig.accel * 0.04));
      rig.lean += (leanTarget - rig.lean) * (1 - Math.exp(-step * 8));

      const breathe = Math.sin(now * 1.7 + rig.seed * 9);
      const stride = moving * (0.34 + 0.62 * s);
      const swing = moving * (0.3 + 0.55 * s);

      // Kick: backswing, strike, follow-through on the right leg.
      let kick = 0,
        kickThigh = 0,
        kickKnee = 0;
      const since = sim.time - p.kickT;
      if (Number.isFinite(since) && since >= 0 && since < KICK_SECONDS) {
        const k = since / KICK_SECONDS;
        kick = Math.min(1, (1 - k) * 5);
        if (k < 0.3) {
          kickThigh = 0.8 * (k / 0.3);
          kickKnee = 1.35 * (k / 0.3);
        } else if (k < 0.6) {
          const u = (k - 0.3) / 0.3;
          kickThigh = 0.8 - 2.0 * u;
          kickKnee = 1.35 * (1 - u);
        } else {
          kickThigh = -1.2 * (1 - (k - 0.6) / 0.4);
          kickKnee = 0.08;
        }
      }

      // Keeper: set stance when the ball is near, arms up when it arrives fast.
      let ready = 0,
        reach = 0;
      if (p.role === "GK" && ball && ball.ownerId !== p.id) {
        const d = Math.hypot(ball.x - p.x, ball.y - p.y);
        const ballSpeed = Math.hypot(ball.vx || 0, ball.vy || 0);
        ready = 1 - smoothstep(14, 24, d);
        if (d < 9 && ballSpeed > 9) reach = 1;
      }
      rig.gkReady += (ready - rig.gkReady) * (1 - Math.exp(-step * 6));
      rig.gkReach += (reach - rig.gkReach) * (1 - Math.exp(-step * 12));

      rig.pelvis.position.y =
        HIP -
        0.012 * moving -
        0.07 * rig.gkReady * (1 - moving) +
        0.032 * moving * (0.4 + s) * Math.abs(Math.sin(rig.phase)) -
        0.02 * kick;
      rig.upper.rotation.x =
        rig.lean - 0.1 * kick + 0.12 * rig.gkReady * (1 - moving);
      rig.upper.rotation.y = Math.sin(rig.phase) * 0.12 * stride;
      rig.upper.scale.y = 1 + breathe * 0.006 * (1 - moving);
      rig.head.rotation.x = -rig.lean * 0.6;

      for (let i = 0; i < 2; i++) {
        const { leg, shin, side } = rig.legs[i];
        const phi = rig.phase + (i ? Math.PI : 0);
        let thigh =
          -stride * Math.sin(phi) -
          0.14 * moving * s -
          0.18 * rig.gkReady * (1 - moving);
        let knee =
          0.06 +
          moving * (0.3 + 1.05 * s) * Math.max(0, Math.cos(phi)) +
          0.4 * rig.gkReady * (1 - moving);
        if (i === 1 && kick > 0) {
          thigh += (kickThigh - thigh) * kick;
          knee += (kickKnee - knee) * kick;
        }
        leg.rotation.x = thigh;
        leg.rotation.z = side * (0.02 + 0.1 * rig.gkReady * (1 - moving));
        shin.rotation.x = knee;
      }
      for (let i = 0; i < 2; i++) {
        const { arm, fore, side } = rig.arms[i];
        const phi = rig.phase + (i ? Math.PI : 0);
        let shoulder = swing * Math.sin(phi) + breathe * 0.015;
        let elbow = -(0.22 + moving * (0.75 + 0.5 * s));
        let spread = 0.09 + 0.05 * moving;
        if (kick > 0) shoulder += (i === 0 ? -0.7 : 0.5) * kick;
        spread += rig.gkReady * 0.55 + rig.gkReach * 1.9;
        shoulder -= rig.gkReady * 0.35 * (1 - rig.gkReach);
        elbow = elbow * (1 - rig.gkReach) - 0.15 * rig.gkReach;
        arm.rotation.x = shoulder;
        arm.rotation.z = side * spread;
        fore.rotation.x = elbow;
      }
    }

    // Ground markers.
    let human = null,
      owner = null;
    for (let i = 0; i < sim.players.length; i++) {
      const p = sim.players[i];
      if (sim.human && p.id === sim.human.playerId) human = p;
      if (ball?.ownerId && p.id === ball.ownerId) owner = p;
    }
    this.humanRing.visible = this.humanGlow.visible = !!human;
    if (human) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 4.2);
      this.humanRing.position.set(human.x, 0.035, human.y);
      this.humanGlow.position.set(human.x, 0.034, human.y);
      this.humanGlow.scale.setScalar(1 + pulse * 0.22);
      this.humanGlow.material.opacity = 0.42 * (1 - pulse * 0.75);
      this.humanRing.material.opacity = 0.78 + 0.22 * pulse;
    }
    this.carrierRing.visible = !!owner && owner !== human;
    if (this.carrierRing.visible) {
      this.carrierRing.position.set(owner.x, 0.036, owner.y);
    }
  }
  dispose() {
    for (const rig of this.rigs.values()) rig.dispose();
    for (const geometry of cache.values()) geometry.dispose();
    cache.clear();
  }
}
