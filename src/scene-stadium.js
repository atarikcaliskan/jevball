import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PITCH, TEAMS } from "./pitch.js";
import {
  FONT,
  canvasTexture,
  flat,
  lawn,
  metricUV,
  paint,
  painted,
  pbr,
} from "./materials.js";
import { renderProfile } from "./render-profile.js";

// Bowl footprint: a rounded rectangle around the pitch; stands sweep outward from it.
export const BOWL = {
  halfX: PITCH.halfL + 10.5,
  halfZ: PITCH.halfW + 8.5,
  radius: 16,
  apronX: 7,
  apronZ: 4.6,
  boardsZ: PITCH.halfW + 5.1,
  boardsX: PITCH.halfL + 6.2,
  depth: 26.6,
  roofInner: 7.5,
  roofHeight: 27,
};

const INK = "#171a20";
const WHITE = "#f4f5f6";
const CONCRETE = "#b9bec4";

/** Collects flat-shaded, vertex-painted quads so whole structures become one draw call. */
class Builder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = [];
    this.color = new THREE.Color();
  }
  tri(a, b, c, hint, color, ua = [0, 0], ub = [0, 0], uc = [0, 0]) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const order = flip ? [a, c, b] : [a, b, c];
    const uvs = flip ? [ua, uc, ub] : [ua, ub, uc];
    this.color.set(color);
    for (let i = 0; i < 3; i++) {
      this.p.push(order[i][0], order[i][1], order[i][2]);
      this.n.push(nx, ny, nz);
      this.c.push(this.color.r, this.color.g, this.color.b);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
  }
  quad(a, b, c, d, hint, color, uvs) {
    const u = uvs || [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    this.tri(a, b, c, hint, color, u[0], u[1], u[2]);
    this.tri(a, c, d, hint, color, u[0], u[2], u[3]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

function boxAt(w, h, d, x, y, z, color, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return paint(g, color);
}

const UP = new THREE.Vector3(0, 1, 0);
function bar(a, b, radius, color, segments = 8) {
  const from = new THREE.Vector3(...a),
    to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const g = new THREE.CylinderGeometry(
    radius,
    radius,
    dir.length(),
    segments,
    1,
  );
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()),
  );
  g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return paint(g, color);
}

// Closed loop of inner-edge samples with outward normals (4 rounded corners).
function bowlRing(perCorner = 10) {
  const { halfX, halfZ, radius: R } = BOWL;
  const corners = [
    [halfX - R, halfZ - R, Math.PI / 2, 0],
    [halfX - R, -(halfZ - R), 0, -Math.PI / 2],
    [-(halfX - R), -(halfZ - R), -Math.PI / 2, -Math.PI],
    [-(halfX - R), halfZ - R, Math.PI, Math.PI / 2],
  ];
  const ring = [];
  for (const [cx, cz, a0, a1] of corners)
    for (let i = 0; i <= perCorner; i++) {
      const a = a0 + ((a1 - a0) * i) / perCorner;
      ring.push({
        x: cx + Math.cos(a) * R,
        z: cz + Math.sin(a) * R,
        nx: Math.cos(a),
        nz: Math.sin(a),
        straightNext: i === perCorner,
        cornerIndex: i,
      });
    }
  return { ring, perCorner };
}

function standProfile() {
  // (d, h) polyline swept around the ring, plus the seat rows for the crowd.
  const points = [[0, 0, WHITE]];
  const rows = [];
  let d = 0,
    h = 1.3;
  points.push([d, h, WHITE]);
  const tier = (count, tread, rise, seat, id) => {
    for (let k = 0; k < count; k++) {
      rows.push({ d: d + tread * 0.5, h, tier: id });
      d += tread;
      points.push([d, h, CONCRETE]);
      if (k < count - 1) {
        h += rise;
        points.push([d, h, seat]);
      }
    }
  };
  tier(14, 0.85, 0.42, "#9c2a2f", 0);
  d += 1.5;
  points.push([d, h, CONCRETE]);
  h = 9.6;
  points.push([d, h, "#20242c"]);
  tier(14, 0.8, 0.56, "#2c3a55", 1);
  d += 1.0;
  points.push([d, h, CONCRETE]);
  points.push([d, 24, "#d5d9de"]);
  points.push([BOWL.depth, 24, WHITE]);
  points.push([BOWL.depth, 0, "#dfe3e7"]);
  return { points, rows };
}

function at(sample, d, h) {
  return [sample.x + sample.nx * d, h, sample.z + sample.nz * d];
}

function buildStands(group) {
  const { ring, perCorner } = bowlRing();
  const { points, rows } = standProfile();
  const b = new Builder();
  for (let i = 0; i < ring.length; i++) {
    const s0 = ring[i],
      s1 = ring[(i + 1) % ring.length];
    const mx = (s0.nx + s1.nx) / 2,
      mz = (s0.nz + s1.nz) / 2;
    for (let k = 0; k < points.length - 1; k++) {
      const [d0, h0] = points[k],
        [d1, h1, color] = points[k + 1];
      const n2d = -(h1 - h0),
        n2h = d1 - d0;
      b.quad(
        at(s0, d0, h0),
        at(s1, d0, h0),
        at(s1, d1, h1),
        at(s0, d1, h1),
        [mx * n2d, n2h, mz * n2d],
        color,
      );
    }
  }
  const geoms = [];

  // Roof trusses and the fascia ring under the translucent canopy.
  const roof = new Builder();
  const rOuter = [BOWL.depth, 24.4],
    rInner = [BOWL.roofInner, BOWL.roofHeight];
  for (let i = 0; i < ring.length; i++) {
    const s0 = ring[i],
      s1 = ring[(i + 1) % ring.length];
    const a = at(s0, rOuter[0], rOuter[1]),
      bb = at(s1, rOuter[0], rOuter[1]),
      c = at(s1, rInner[0], rInner[1]),
      d = at(s0, rInner[0], rInner[1]);
    roof.quad(a, bb, c, d, [0, 1, 0], "#ffffff");
    const f0 = at(s0, rInner[0], rInner[1] - 0.9),
      f1 = at(s1, rInner[0], rInner[1] - 0.9),
      f2 = at(s1, rInner[0], rInner[1] + 0.5),
      f3 = at(s0, rInner[0], rInner[1] + 0.5);
    const mx = (s0.nx + s1.nx) / 2,
      mz = (s0.nz + s1.nz) / 2;
    b.quad(f0, f1, f2, f3, [-mx, 0, -mz], INK);
    b.quad(f0, f1, f2, f3, [mx, 0, mz], WHITE);
  }
  geoms.push(b.geometry());
  // Trusses: every corner sample + every ~13 m along the straights.
  const trussAt = (s) =>
    geoms.push(
      bar(
        at(s, BOWL.depth - 0.4, 24.1),
        at(s, BOWL.roofInner + 0.2, BOWL.roofHeight - 0.35),
        0.22,
        "#e9ecef",
        6,
      ),
    );
  for (let i = 0; i < ring.length; i++) {
    const s0 = ring[i],
      s1 = ring[(i + 1) % ring.length];
    if (i % 2 === 0) trussAt(s0);
    if (s0.straightNext) {
      const len = Math.hypot(s1.x - s0.x, s1.z - s0.z);
      const n = Math.round(len / 13);
      for (let k = 1; k < n; k++)
        trussAt({
          x: s0.x + ((s1.x - s0.x) * k) / n,
          z: s0.z + ((s1.z - s0.z) * k) / n,
          nx: s0.nx,
          nz: s0.nz,
        });
    }
  }
  const roofMesh = new THREE.Mesh(
    roof.geometry(),
    flat("#f7f9fb", {
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      roughness: 0.4,
    }),
  );
  roofMesh.castShadow = false;
  roofMesh.receiveShadow = false;
  roofMesh.renderOrder = 1;
  group.add(roofMesh);
  return { geoms, ring, rows, perCorner };
}

function crowdFigure() {
  // Drop faces nobody can see (undersides, the lap's back) — a third fewer crowd triangles.
  const part = (g, id, hidden = [3]) => {
    const index = Array.from(g.index.array).filter(
      (_, i) => !hidden.includes(Math.floor(i / 6)),
    );
    g.setIndex(index);
    const n = g.toNonIndexed();
    n.setAttribute(
      "aPart",
      new THREE.BufferAttribute(
        new Float32Array(n.attributes.position.count).fill(id),
        1,
      ),
    );
    return n;
  };
  const torso = new THREE.BoxGeometry(0.44, 0.54, 0.25).translate(0, 0.62, 0);
  const lap = new THREE.BoxGeometry(0.4, 0.16, 0.44).translate(0, 0.4, 0.2);
  const head = new THREE.BoxGeometry(0.2, 0.23, 0.21).translate(0, 1.03, 0.01);
  return mergeGeometries([part(torso, 0), part(lap, 2, [3, 5]), part(head, 1)]);
}

const HOME_FANS = [
  "#e82127",
  "#e82127",
  "#d01c22",
  "#ffffff",
  "#f1f1f1",
  "#a5161b",
  "#e82127",
];
const AWAY_FANS = [
  "#3e6ae1",
  "#3e6ae1",
  "#2f55c0",
  "#ffffff",
  "#171a20",
  "#5a82ee",
];
const NEUTRAL_FANS = [
  "#e9e6df",
  "#c9ccd2",
  "#8d97a5",
  "#4a5568",
  "#2d3340",
  "#d8c7a8",
  "#6f8aa8",
  "#b8493f",
  "#f1d9a0",
  "#7a8f6a",
  "#20242c",
  "#ffffff",
];

function buildCrowd(group, ring, rows) {
  let seed = 20260918;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const seats = [];
  const spacing = renderProfile.crowdSpacing;
  for (const row of rows) {
    for (let i = 0; i < ring.length; i++) {
      const s0 = ring[i],
        s1 = ring[(i + 1) % ring.length];
      const ax = s0.x + s0.nx * row.d,
        az = s0.z + s0.nz * row.d,
        bx = s1.x + s1.nx * row.d,
        bz = s1.z + s1.nz * row.d;
      const len = Math.hypot(bx - ax, bz - az);
      const count = Math.floor(len / spacing);
      const pad = (len - count * spacing) / 2 + spacing / 2;
      for (let k = 0; k < count; k++) {
        const t = pad + k * spacing;
        if (s0.straightNext) {
          const fromMid = t - len / 2;
          if (Math.abs(((((fromMid + 7) % 14) + 14) % 14) - 7) < 0.7) continue;
        } else if (
          (s0.cornerIndex === 0 && t < 0.7) ||
          (s1.straightNext && len - t < 0.7)
        )
          continue;
        if (rand() > renderProfile.crowdOccupancy) continue;
        const f = t / len;
        const nx = s0.nx + (s1.nx - s0.nx) * f,
          nz = s0.nz + (s1.nz - s0.nz) * f;
        const x = ax + (bx - ax) * f,
          z = az + (bz - az) * f;
        // Home end behind the −x goal, away pocket in the far +x corner.
        const homeEnd = x < -PITCH.halfL - 4;
        const awayPocket = x > 34 && z < -18;
        const r = rand();
        let color,
          home = 0.45,
          away = 0.1;
        if (awayPocket && r < 0.9) {
          color = pick(AWAY_FANS);
          home = 0;
          away = 1;
        } else if (!awayPocket && r < (homeEnd ? 0.9 : 0.4)) {
          color = pick(HOME_FANS);
          home = 1;
          away = 0;
        } else color = pick(NEUTRAL_FANS);
        seats.push({
          x,
          y: row.h,
          z,
          nx,
          nz,
          color,
          home,
          away,
          phase: rand() * Math.PI * 2,
          scale: 0.92 + rand() * 0.18,
        });
      }
    }
  }
  const geometry = crowdFigure();
  const fans = new Float32Array(seats.length * 3);
  const uniforms = {
    uTime: { value: 0 },
    uCheer: { value: new THREE.Vector2() },
    uSkinA: { value: new THREE.Color("#e2b594") },
    uSkinB: { value: new THREE.Color("#8a5a3c") },
    uTrousers: { value: new THREE.Color("#2b303b") },
  };
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aPart; attribute vec3 aFan;
        uniform float uTime; uniform vec2 uCheer; uniform vec3 uSkinA; uniform vec3 uSkinB; uniform vec3 uTrousers;`,
      )
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>
        float tone = fract(aFan.z * 7.31);
        vec3 skin = mix(uSkinA, uSkinB, step(0.72, tone) * 0.9 + tone * 0.1);
        vColor.xyz = aPart > 1.5 ? mix(uTrousers, vColor.xyz, 0.18) : mix(vColor.xyz, skin, aPart);`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float cheer = dot(aFan.xy, uCheer);
        float hop = abs(sin(uTime * 5.5 + aFan.z));
        transformed.y += cheer * hop * 0.42 * (aPart > 1.5 ? 0.35 : 1.0) + sin(uTime * 1.3 + aFan.z) * 0.012;`,
      );
  };
  const mesh = new THREE.InstancedMesh(geometry, material, seats.length);
  const dummy = new THREE.Object3D(),
    color = new THREE.Color();
  seats.forEach((seat, i) => {
    dummy.position.set(seat.x, seat.y, seat.z);
    dummy.rotation.set(0, Math.atan2(-seat.nx, -seat.nz), 0);
    dummy.scale.set(1, seat.scale, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color.set(seat.color));
    fans[i * 3] = seat.home;
    fans[i * 3 + 1] = seat.away;
    fans[i * 3 + 2] = seat.phase;
  });
  geometry.setAttribute("aFan", new THREE.InstancedBufferAttribute(fans, 3));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  group.add(mesh);
  return { mesh, uniforms, count: seats.length };
}

function buildPitch(group) {
  const grass = lawn(7);
  const b = new Builder();
  const up = [0, 1, 0];
  const band = (x0, x1, z0, z1, color, y = 0) =>
    b.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], up, color);
  // Mowing stripes: 5.5 m bands counted from each goal line (they line up with the boxes).
  const edges = [];
  for (let i = 0; i <= 9; i++) edges.push(-PITCH.halfL + i * 5.5);
  for (let i = 9; i >= 0; i--) edges.push(PITCH.halfL - i * 5.5);
  for (let i = 0; i < edges.length - 1; i++)
    band(
      edges[i],
      edges[i + 1],
      -PITCH.halfW,
      PITCH.halfW,
      i % 2 ? "#ffffff" : "#cfe3c4",
    );
  const ax = PITCH.halfL + BOWL.apronX,
    az = PITCH.halfW + BOWL.apronZ,
    apron = "#c3d6b6";
  band(-ax, ax, -az, -PITCH.halfW, apron);
  band(-ax, ax, PITCH.halfW, az, apron);
  band(-ax, -PITCH.halfL, -PITCH.halfW, PITCH.halfW, apron);
  band(PITCH.halfL, ax, -PITCH.halfW, PITCH.halfW, apron);
  const mesh = new THREE.Mesh(metricUV(b.geometry(), grass), grass);
  mesh.receiveShadow = true;
  group.add(mesh);

  // Pavement track up to the stand wall, then a plaza and meadow to the horizon.
  const pavement = pbr("pavement", "#d9d6cd", 2.5);
  const track = new THREE.Mesh(
    metricUV(
      new THREE.PlaneGeometry(
        (BOWL.halfX + 1) * 2,
        (BOWL.halfZ + 1) * 2,
      ).rotateX(-Math.PI / 2),
      pavement,
    ),
    pavement,
  );
  track.position.y = -0.02;
  track.receiveShadow = true;
  group.add(track);
  const plaza = pbr("pavement", "#cfccc2", 6);
  const outer = new THREE.Mesh(
    metricUV(new THREE.PlaneGeometry(420, 360).rotateX(-Math.PI / 2), plaza),
    plaza,
  );
  outer.position.y = -0.06;
  group.add(outer);
  const meadow = pbr("grass", "#b4bf91", 9);
  const land = new THREE.Mesh(
    metricUV(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), meadow),
    meadow,
  );
  land.position.y = -0.12;
  group.add(land);
}

function buildLines(group) {
  const b = new Builder();
  const up = [0, 1, 0],
    y = 0.016,
    w = 0.12,
    color = "#ffffff";
  const hline = (x0, x1, z) =>
    b.quad(
      [x0, y, z - w / 2],
      [x1, y, z - w / 2],
      [x1, y, z + w / 2],
      [x0, y, z + w / 2],
      up,
      color,
    );
  const vline = (x, z0, z1) =>
    b.quad(
      [x - w / 2, y, z0],
      [x + w / 2, y, z0],
      [x + w / 2, y, z1],
      [x - w / 2, y, z1],
      up,
      color,
    );
  const arc = (cx, cz, r, a0, a1, segments = 48) => {
    for (let i = 0; i < segments; i++) {
      const t0 = a0 + ((a1 - a0) * i) / segments,
        t1 = a0 + ((a1 - a0) * (i + 1)) / segments;
      const p = (t, rr) => [cx + Math.cos(t) * rr, y, cz + Math.sin(t) * rr];
      b.quad(
        p(t0, r - w / 2),
        p(t1, r - w / 2),
        p(t1, r + w / 2),
        p(t0, r + w / 2),
        up,
        color,
      );
    }
  };
  const disc = (cx, cz, r) => {
    for (let i = 0; i < 16; i++) {
      const t0 = (i / 16) * Math.PI * 2,
        t1 = ((i + 1) / 16) * Math.PI * 2;
      b.tri(
        [cx, y, cz],
        [cx + Math.cos(t0) * r, y, cz + Math.sin(t0) * r],
        [cx + Math.cos(t1) * r, y, cz + Math.sin(t1) * r],
        up,
        color,
      );
    }
  };
  const L = PITCH.halfL,
    W = PITCH.halfW;
  hline(-L - w / 2, L + w / 2, -W);
  hline(-L - w / 2, L + w / 2, W);
  vline(-L, -W, W);
  vline(L, -W, W);
  vline(0, -W, W);
  arc(0, 0, PITCH.centerCircle, 0, Math.PI * 2, 72);
  disc(0, 0, 0.18);
  for (const s of [-1, 1]) {
    const gx = s * L;
    const box = (depth, width) => {
      vline(gx - s * depth, -width / 2, width / 2);
      hline(
        Math.min(gx, gx - s * depth),
        Math.max(gx, gx - s * depth),
        -width / 2,
      );
      hline(
        Math.min(gx, gx - s * depth),
        Math.max(gx, gx - s * depth),
        width / 2,
      );
    };
    box(PITCH.penaltyAreaDepth, PITCH.penaltyAreaWidth);
    box(PITCH.goalAreaDepth, PITCH.goalAreaWidth);
    const spotX = gx - s * PITCH.penaltySpot;
    disc(spotX, 0, 0.16);
    const half = Math.acos(
      (PITCH.penaltyAreaDepth - PITCH.penaltySpot) / PITCH.centerCircle,
    );
    const mid = s > 0 ? Math.PI : 0;
    arc(spotX, 0, PITCH.centerCircle, mid - half, mid + half, 28);
    for (const t of [-1, 1]) {
      // Quarter circle opening into the pitch.
      const start =
        s > 0 ? (t > 0 ? Math.PI : Math.PI / 2) : t > 0 ? -Math.PI / 2 : 0;
      arc(gx, t * W, PITCH.cornerArc, start, start + Math.PI / 2, 10);
    }
  }
  const mesh = new THREE.Mesh(
    b.geometry(),
    flat("#f6f8f4", {
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.receiveShadow = true;
  group.add(mesh);
}

function netTexture() {
  const map = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = 7;
    ctx.strokeRect(0, 0, w, h);
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

function buildGoals(group, geoms) {
  const cell = 0.16;
  const net = new Builder();
  const H = PITCH.goalHeight,
    half = PITCH.goalWidth / 2,
    D = PITCH.goalDepth,
    topD = 0.95,
    topH = H - 0.12;
  for (const s of [-1, 1]) {
    const X = (d) => s * (PITCH.halfL + d);
    for (const t of [-1, 1]) {
      geoms.push(
        bar(
          [X(0), 0, t * half],
          [X(0), H + 0.06, t * half],
          0.06,
          "#ffffff",
          14,
        ),
      );
      geoms.push(
        bar([X(0), H, t * half], [X(topD), topH, t * half], 0.028, "#eef0f2"),
      );
      geoms.push(
        bar(
          [X(topD), topH, t * half],
          [X(D), 0.03, t * half],
          0.028,
          "#eef0f2",
        ),
      );
      geoms.push(
        bar([X(0), 0.03, t * half], [X(D), 0.03, t * half], 0.028, "#eef0f2"),
      );
    }
    geoms.push(
      bar([X(0), H, -half - 0.06], [X(0), H, half + 0.06], 0.06, "#ffffff", 14),
    );
    geoms.push(bar([X(D), 0.03, -half], [X(D), 0.03, half], 0.028, "#eef0f2"));
    geoms.push(
      bar([X(topD), topH, -half], [X(topD), topH, half], 0.028, "#eef0f2"),
    );
    const wz = PITCH.goalWidth / cell;
    const slope = Math.hypot(D - topD, topH);
    // top, back slope, two sides
    net.quad(
      [X(0), H, -half],
      [X(0), H, half],
      [X(topD), topH, half],
      [X(topD), topH, -half],
      [0, 1, 0],
      "#ffffff",
      [
        [0, 0],
        [wz, 0],
        [wz, topD / cell],
        [0, topD / cell],
      ],
    );
    net.quad(
      [X(topD), topH, -half],
      [X(topD), topH, half],
      [X(D), 0, half],
      [X(D), 0, -half],
      [s, 0.4, 0],
      "#ffffff",
      [
        [0, 0],
        [wz, 0],
        [wz, slope / cell],
        [0, slope / cell],
      ],
    );
    for (const t of [-1, 1]) {
      const z = t * half;
      net.quad(
        [X(0), 0, z],
        [X(D), 0, z],
        [X(topD), topH, z],
        [X(0), H, z],
        [0, 0, t],
        "#ffffff",
        [
          [0, 0],
          [D / cell, 0],
          [topD / cell, topH / cell],
          [0, H / cell],
        ],
      );
    }
  }
  const material = new THREE.MeshBasicMaterial({
    map: netTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: "#ffffff",
  });
  const mesh = new THREE.Mesh(net.geometry(), material);
  mesh.geometry.deleteAttribute("color");
  mesh.renderOrder = 2;
  group.add(mesh);
}

// LED perimeter boards in the matchday-broadcast identity (docs/THEME.md).
const LED = {
  ink: "#0a120e",
  chalk: "#f4f1e8",
  dim: "#a9b5ab",
  flood: "#ffe14a",
  turf: "#14502c",
  home: "#e82127",
  away: "#3e6ae1",
};
const BOARD_DESIGNS = [
  {
    text: "JEVBALL",
    bg: LED.ink,
    fg: LED.chalk,
    accent: LED.flood,
    mark: true,
  },
  { text: "22 × JEV", bg: LED.flood, fg: LED.ink, accent: LED.ink },
  { text: "SYSTEM ONE FC", bg: LED.ink, fg: LED.chalk, accent: LED.away },
  {
    text: "EVERY PLAYER A MODEL",
    bg: LED.turf,
    fg: LED.chalk,
    accent: LED.flood,
  },
  {
    text: "PICK · PASS · SCORE",
    bg: LED.ink,
    fg: LED.flood,
    accent: LED.chalk,
  },
  { text: "JEV UNITED", bg: LED.ink, fg: LED.chalk, accent: LED.home },
  { text: "JEVBALL", bg: LED.chalk, fg: LED.ink, accent: LED.ink, mark: true },
  { text: "22 × JEV", bg: LED.ink, fg: LED.chalk, accent: LED.flood },
];

function spaced(ctx, px) {
  try {
    ctx.letterSpacing = `${px}px`;
  } catch {}
}
/** Parallelogram slab (the TV score-bug shape): x..x+w at the top, leaning by `lean` px. */
function slab(ctx, x, y, w, h, lean) {
  ctx.beginPath();
  ctx.moveTo(x + lean, y);
  ctx.lineTo(x + w + lean, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
}

function boardAtlas() {
  const rows = BOARD_DESIGNS.length,
    rowH = 128;
  return canvasTexture(1024, rows * rowH, (ctx, w) => {
    BOARD_DESIGNS.forEach((design, i) => {
      const y = i * rowH;
      ctx.fillStyle = design.bg;
      ctx.fillRect(0, y, w, rowH);
      // Skewed accent slabs on both ends, chalk hairline top and bottom.
      ctx.fillStyle = design.accent;
      slab(ctx, 22, y + 22, 30, rowH - 44, 16);
      slab(ctx, 66, y + 22, 9, rowH - 44, 16);
      slab(ctx, w - 68, y + 22, 30, rowH - 44, 16);
      slab(ctx, w - 91, y + 22, 9, rowH - 44, 16);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = design.fg;
      ctx.fillRect(0, y + 6, w, 3);
      ctx.fillRect(0, y + rowH - 9, w, 3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = design.fg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      spaced(ctx, 6);
      let size = 104;
      ctx.font = `700 ${size}px ${FONT}`;
      const room = w - 250 - (design.mark ? 90 : 0);
      const width = ctx.measureText(design.text).width;
      if (width > room) {
        size *= room / width;
        ctx.font = `700 ${size}px ${FONT}`;
      }
      const cx = w / 2 + (design.mark ? 48 : 0);
      ctx.fillText(design.text, cx, y + rowH / 2 + 5);
      if (design.mark) {
        // Pitch-circle mark with a floodlight dot.
        const tw = Math.min(width, room),
          mx = cx - tw / 2 - 62,
          my = y + rowH / 2;
        ctx.strokeStyle = design.fg;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.arc(mx, my, 30, 0, Math.PI * 2);
        ctx.moveTo(mx, my - 30);
        ctx.lineTo(mx, my + 30);
        ctx.stroke();
        ctx.fillStyle = design.bg === LED.chalk ? LED.home : LED.flood;
        ctx.beginPath();
        ctx.arc(mx, my, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      spaced(ctx, 0);
    });
  });
}

function buildBoards(group, geoms) {
  const atlas = boardAtlas();
  const b = new Builder();
  const rows = BOARD_DESIGNS.length,
    H = 0.98,
    y0 = 0.06;
  let index = 0;
  const panel = (x0, z0, x1, z1, facing) => {
    const design = index++ % rows;
    const v0 = 1 - (design + 1) / rows + 0.004,
      v1 = 1 - design / rows - 0.004;
    b.quad(
      [x0, y0, z0],
      [x1, y0, z1],
      [x1, y0 + H, z1],
      [x0, y0 + H, z0],
      facing,
      "#ffffff",
      [
        [0.003, v0],
        [0.997, v0],
        [0.997, v1],
        [0.003, v1],
      ],
    );
    const cx = (x0 + x1) / 2 - facing[0] * 0.17,
      cz = (z0 + z1) / 2 - facing[2] * 0.17;
    const along = Math.hypot(x1 - x0, z1 - z0);
    geoms.push(
      boxAt(
        facing[0] ? 0.3 : along,
        H + 0.06,
        facing[0] ? along : 0.3,
        cx,
        y0 + H / 2 - 0.03,
        cz,
        "#1d2128",
      ),
    );
  };
  const panelW = 8;
  // Touchline boards face the pitch. UVs must read left→right for the viewer on the pitch side.
  for (const side of [-1, 1]) {
    const z = side * BOWL.boardsZ;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const xa = -((n * panelW) / 2) + i * panelW,
        xb = xa + panelW;
      if (side < 0) panel(xa, z, xb, z, [0, 0, 1]);
      else panel(xb, z, xa, z, [0, 0, -1]);
    }
  }
  for (const end of [-1, 1]) {
    const x = end * BOWL.boardsX;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const za = -((n * panelW) / 2) + i * panelW,
        zb = za + panelW;
      if (end > 0) panel(x, za, x, zb, [-1, 0, 0]);
      else panel(x, zb, x, za, [1, 0, 0]);
    }
  }
  const material = new THREE.MeshBasicMaterial({
    map: atlas,
    color: "#eeeeee",
    toneMapped: false,
  });
  const geometry = b.geometry();
  geometry.deleteAttribute("color");
  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);
  return atlas;
}

function buildFloodlights(group, geoms) {
  const lamps = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * (BOWL.halfX + 22),
        z = sz * (BOWL.halfZ + 21),
        h = 47;
      geoms.push(bar([x, 0, z], [x, h, z], 0.75, "#cfd4da", 10));
      geoms.push(bar([x, 0, z], [x, 6, z], 1.15, "#aeb4bc", 10));
      const yaw = Math.atan2(-x, -z);
      const head = new THREE.BoxGeometry(11, 6.6, 0.7);
      head.rotateX(-0.32);
      head.rotateY(yaw);
      head.translate(x, h + 1.5, z);
      geoms.push(paint(head, "#2a2f38"));
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 7; c++) {
          const lamp = new THREE.BoxGeometry(1.1, 1.1, 0.25);
          lamp.translate((c - 3) * 1.45, (r - 1.5) * 1.5, 0.42);
          lamp.rotateX(-0.32);
          lamp.rotateY(yaw);
          lamp.translate(x, h + 1.5, z);
          lamps.push(lamp);
        }
    }
  const mesh = new THREE.Mesh(
    mergeGeometries(lamps),
    new THREE.MeshBasicMaterial({ color: "#fffbe8", toneMapped: false }),
  );
  group.add(mesh);
}

function buildDugouts(group, geoms) {
  const glass = [];
  TEAMS.forEach((team, i) => {
    const cx = (i ? 1 : -1) * 13,
      z = -(PITCH.halfW + 3.3),
      w = 9.5;
    geoms.push(boxAt(w, 0.12, 1.9, cx, 0.06, z, "#2a2f38"));
    geoms.push(boxAt(w, 0.4, 0.5, cx, 0.32, z - 0.45, "#23272f"));
    for (let k = 0; k < 9; k++) {
      const x = cx - w / 2 + 0.75 + k * 1.0;
      geoms.push(boxAt(0.62, 0.12, 0.55, x, 0.58, z - 0.4, team.colors.shirt));
      geoms.push(boxAt(0.62, 0.7, 0.12, x, 0.92, z - 0.66, team.colors.shirt));
    }
    for (const e of [-1, 1])
      geoms.push(boxAt(0.1, 2.1, 1.9, cx + (e * w) / 2, 1.05, z, WHITE));
    geoms.push(boxAt(w + 0.1, 0.1, 0.12, cx, 2.12, z + 0.9, WHITE));
    glass.push(
      new THREE.BoxGeometry(w, 2.0, 0.06).translate(cx, 1.05, z - 0.92),
    );
    glass.push(
      new THREE.BoxGeometry(w, 0.06, 1.9).rotateX(0.12).translate(cx, 2.12, z),
    );
  });
  const mesh = new THREE.Mesh(
    mergeGeometries(glass),
    flat("#cfe6f2", {
      transparent: true,
      opacity: 0.42,
      roughness: 0.15,
      metalness: 0,
    }),
  );
  mesh.renderOrder = 1;
  group.add(mesh);
}

function buildFlags(geoms) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * PITCH.halfL,
        z = sz * PITCH.halfW;
      geoms.push(bar([x, 0, z], [x, 1.55, z], 0.022, "#f5f0c8", 6));
      geoms.push(
        boxAt(
          0.42,
          0.28,
          0.015,
          x - sx * 0.22,
          1.4,
          z,
          "#e82127",
          sx * sz * 0.5,
        ),
      );
    }
}

class Scoreboard {
  constructor(group, geoms) {
    this.key = "";
    this.state = { score: [0, 0], label: "0'", phase: "kickoff" };
    this.texture = canvasTexture(1040, 240, (ctx, w, h) =>
      this.draw(ctx, w, h),
    );
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      toneMapped: false,
    });
    // Sized to clear the heads of the back row below and the canopy above.
    const W = 25.4,
      H = W * (240 / 1040),
      Y = 20.85;
    for (const end of [-1, 1]) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), material);
      const x = end * (BOWL.halfX + BOWL.depth - 1.35);
      mesh.position.set(x, Y, 0);
      mesh.rotation.y = end > 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(mesh);
      geoms.push(boxAt(0.5, H + 0.7, W + 0.7, x + end * 0.3, Y, 0, "#0a120e"));
    }
  }
  /** Stadium big-screen version of the TV score bug: team slabs, big score, minute slab. */
  draw(ctx, w, h) {
    const { score, label, phase } = this.state;
    const top = 22,
      barH = 136,
      mid = top + barH / 2 + 6,
      lean = 30;
    ctx.fillStyle = LED.ink;
    ctx.fillRect(0, 0, w, h);
    // Pitch-marking motif behind everything.
    ctx.strokeStyle = "#f4f1e814";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 170, 0, Math.PI * 2);
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.textBaseline = "middle";
    // Team slabs: colour bar on the outer edge, short name in chalk.
    const team = (t, side) => {
      const x0 = side < 0 ? 28 : w / 2 + 150,
        width = w / 2 - 182;
      ctx.fillStyle = "#16261d";
      slab(ctx, x0, top, width, barH, lean);
      ctx.fillStyle = t.colors.shirt;
      if (side < 0) slab(ctx, x0, top, 34, barH, lean);
      else slab(ctx, x0 + width - 34, top, 34, barH, lean);
      ctx.fillStyle = LED.chalk;
      ctx.textAlign = "center";
      spaced(ctx, 8);
      ctx.font = `700 124px ${FONT}`;
      ctx.fillText(t.short, x0 + width / 2 + lean / 2 + side * -14, mid);
    };
    team(TEAMS[0], -1);
    team(TEAMS[1], 1);
    // Score: chalk slab, ink digits.
    ctx.fillStyle = LED.chalk;
    slab(ctx, w / 2 - 150, top - 8, 300 - lean, barH + 16, lean);
    ctx.fillStyle = LED.ink;
    ctx.textAlign = "center";
    spaced(ctx, 2);
    ctx.font = `700 150px ${FONT}`;
    ctx.fillText(String(score[0]), w / 2 - 68, mid);
    ctx.fillText(String(score[1]), w / 2 + 68, mid);
    ctx.fillRect(w / 2 - 14, mid - 12, 28, 10);
    // Footer: brand left, minute slab centre (yellow; red on a goal), tagline right.
    const fy = h - 36,
      goal = phase === "goal";
    ctx.font = `700 40px ${FONT}`;
    spaced(ctx, 4);
    const lw = Math.max(150, ctx.measureText(label).width + 64);
    ctx.fillStyle = goal ? "#ff4d3d" : LED.flood;
    slab(ctx, w / 2 - lw / 2 - 8, h - 62, lw, 50, 16);
    ctx.fillStyle = goal ? LED.chalk : LED.ink;
    ctx.fillText(label, w / 2, fy + 3);
    ctx.font = `600 34px ${FONT}`;
    ctx.fillStyle = LED.chalk;
    ctx.textAlign = "left";
    ctx.fillText("JEVBALL", 40, fy + 3);
    ctx.fillStyle = LED.dim;
    ctx.textAlign = "right";
    ctx.fillText("EVERY PLAYER A MODEL", w - 40, fy + 3);
    spaced(ctx, 0);
  }
  update(sim) {
    const minute = sim.clock?.minute ?? 0;
    const label =
      sim.phase === "halftime"
        ? "HALF TIME"
        : sim.phase === "fulltime"
          ? "FULL TIME"
          : sim.phase === "goal"
            ? `GOAL · ${minute}'`
            : `${minute}'`;
    const key = `${sim.score?.[0]}:${sim.score?.[1]}:${label}`;
    if (key === this.key) return;
    this.key = key;
    this.state.score = sim.score || [0, 0];
    this.state.label = label;
    this.state.phase = sim.phase;
    this.texture.userData.redraw();
  }
}

export class Stadium {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = "stadium";
    scene.add(this.group);
    buildPitch(this.group);
    buildLines(this.group);
    const { geoms, ring, rows } = buildStands(this.group);
    buildGoals(this.group, geoms);
    this.boardAtlas = buildBoards(this.group, geoms);
    buildFloodlights(this.group, geoms);
    buildDugouts(this.group, geoms);
    buildFlags(geoms);
    this.scoreboard = new Scoreboard(this.group, geoms);
    const props = new THREE.Mesh(mergeGeometries(geoms), painted("props"));
    geoms.forEach((g) => g.dispose());
    props.castShadow = true;
    props.receiveShadow = true;
    this.group.add(props);
    this.crowd = buildCrowd(this.group, ring, rows);
    this.cheer = [0, 0];
    this.cheerUntil = [0, 0];
    this.now = 0;
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
  }
  /** Fans of `team` (0 home / 1 away) bounce for a few seconds. */
  celebrate(team, seconds = 5) {
    if (team !== 0 && team !== 1) return;
    this.cheerUntil[team] = this.now + seconds;
  }
  redrawText() {
    this.boardAtlas.userData.redraw();
    this.scoreboard.texture.userData.redraw();
  }
  update(sim, dt, now) {
    this.now = now;
    const k = 1 - Math.exp(-dt * 4);
    for (let t = 0; t < 2; t++)
      this.cheer[t] += ((now < this.cheerUntil[t] ? 1 : 0) - this.cheer[t]) * k;
    this.crowd.uniforms.uTime.value = now;
    this.crowd.uniforms.uCheer.value.set(this.cheer[0], this.cheer[1]);
    this.scoreboard.update(sim);
  }
}
