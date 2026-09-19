import * as THREE from "three";
import { canvasTexture } from "./materials.js";

const RADIUS = 0.11;
const TRAIL = 18;

// Equirect map of a classic 32-panel ball: black pentagons sit on the 12 icosahedron vertices.
function ballTexture() {
  const t = (1 + Math.sqrt(5)) / 2;
  const centers = [];
  for (const a of [-1, 1])
    for (const b of [-t, t]) {
      centers.push([0, a, b], [a, b, 0], [b, 0, a]);
    }
  const norm = Math.hypot(1, t);
  for (const c of centers) for (let i = 0; i < 3; i++) c[i] /= norm;
  // Hexagon centres = icosahedron face centres; seams run between neighbouring panels.
  const faces = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++)
      for (let k = j + 1; k < 12; k++) {
        const a = centers[i],
          b = centers[j],
          c = centers[k];
        const close = (p, q) =>
          Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1.1;
        if (close(a, b) && close(b, c) && close(a, c)) {
          const f = [
            a[0] + b[0] + c[0],
            a[1] + b[1] + c[1],
            a[2] + b[2] + c[2],
          ];
          const l = Math.hypot(...f);
          faces.push(f.map((v) => v / l));
        }
      }
  return canvasTexture(512, 256, (ctx, w, h) => {
    const image = ctx.createImageData(w, h);
    const d = image.data;
    for (let y = 0; y < h; y++) {
      const phi = ((y + 0.5) / h) * Math.PI;
      for (let x = 0; x < w; x++) {
        const theta = ((x + 0.5) / w) * Math.PI * 2;
        const px = -Math.cos(theta) * Math.sin(phi),
          py = Math.cos(phi),
          pz = Math.sin(theta) * Math.sin(phi);
        let pent = -1,
          hex1 = -1,
          hex2 = -1;
        for (const c of centers)
          pent = Math.max(pent, px * c[0] + py * c[1] + pz * c[2]);
        for (const f of faces) {
          const v = px * f[0] + py * f[1] + pz * f[2];
          if (v > hex1) {
            hex2 = hex1;
            hex1 = v;
          } else if (v > hex2) hex2 = v;
        }
        // Scale the pentagon score so its border with a hexagon falls at the truncation distance.
        const pentScore = pent * 1.052;
        let shade = 244;
        if (pentScore > hex1) shade = 24;
        else if (Math.min(hex1 - pentScore, hex1 - hex2) < 0.006) shade = 120;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = shade;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  });
}

function blobTexture() {
  return canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.55, "rgba(0,0,0,0.22)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export class Ball {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = "ball";
    scene.add(this.group);
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 28, 20),
      new THREE.MeshStandardMaterial({
        map: ballTexture(),
        roughness: 0.42,
        metalness: 0,
      }),
    );
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: blobTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    this.blob.renderOrder = 2;
    this.group.add(this.blob);

    // Camera-facing streak behind fast balls.
    this.history = new Float32Array(TRAIL * 3);
    this.count = 0;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(TRAIL * 6), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    const fade = new Float32Array(TRAIL * 2);
    for (let i = 0; i < TRAIL; i++)
      fade[i * 2] = fade[i * 2 + 1] = 1 - i / (TRAIL - 1);
    geometry.setAttribute("fade", new THREE.BufferAttribute(fade, 1));
    const index = [];
    for (let i = 0; i < TRAIL - 1; i++)
      index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geometry.setIndex(index);
    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0 } },
      vertexShader: `attribute float fade; varying float vFade; void main() { vFade = fade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float strength; varying float vFade; void main() { gl_FragColor = vec4(vec3(1.0), vFade * vFade * strength * 0.5); }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.trail = new THREE.Mesh(geometry, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 3;
    this.group.add(this.trail);
    this.axis = new THREE.Vector3();
    this.spin = new THREE.Quaternion();
    this.view = new THREE.Vector3();
    this.strength = 0;
  }
  update(sim, dt, camera) {
    const b = sim.ball;
    if (!b) return;
    const z = Math.max(0, b.z || 0);
    this.mesh.position.set(b.x, z + RADIUS, b.y);
    const vx = b.vx || 0,
      vy = b.vy || 0,
      vz = b.vz || 0;
    const ground = Math.hypot(vx, vy);
    const step = Math.min(dt, 0.1);
    if (ground > 0.05 && step > 0) {
      // Rolling: spin about the horizontal axis perpendicular to travel.
      this.axis.set(vy / ground, 0, -vx / ground);
      this.spin.setFromAxisAngle(
        this.axis,
        ((ground * step) / RADIUS) * (z > 0.3 ? 0.35 : 1),
      );
      this.mesh.quaternion.premultiply(this.spin).normalize();
    }
    const spread = 0.42 + z * 0.22;
    this.blob.position.set(b.x, 0.02, b.y);
    this.blob.scale.set(spread, 1, spread);
    this.blob.material.opacity = Math.max(0.12, 0.85 - z * 0.12);

    // Trail history (newest first).
    const speed = Math.hypot(ground, vz);
    const h = this.history;
    if (step > 0) {
      const lastX = h[0],
        lastY = h[1],
        lastZ = h[2];
      const jumped =
        Math.hypot(lastX - b.x, lastY - (z + RADIUS), lastZ - b.y) > 6;
      if (jumped || this.count === 0) {
        for (let i = 0; i < TRAIL; i++) {
          h[i * 3] = b.x;
          h[i * 3 + 1] = z + RADIUS;
          h[i * 3 + 2] = b.y;
        }
        this.count = TRAIL;
      } else {
        h.copyWithin(3, 0, (TRAIL - 1) * 3);
        h[0] = b.x;
        h[1] = z + RADIUS;
        h[2] = b.y;
      }
    }
    const target = Math.min(1, Math.max(0, (speed - 11) / 10));
    this.strength += (target - this.strength) * (1 - Math.exp(-step * 8));
    this.trail.visible = this.strength > 0.02;
    if (!this.trail.visible) return;
    this.trailMaterial.uniforms.strength.value = this.strength;
    const position = this.trail.geometry.attributes.position;
    for (let i = 0; i < TRAIL; i++) {
      const a = Math.max(0, i - 1),
        c = Math.min(TRAIL - 1, i + 1);
      const tx = h[a * 3] - h[c * 3],
        ty = h[a * 3 + 1] - h[c * 3 + 1],
        tz = h[a * 3 + 2] - h[c * 3 + 2];
      const px = h[i * 3],
        py = h[i * 3 + 1],
        pz = h[i * 3 + 2];
      this.view.set(
        camera.position.x - px,
        camera.position.y - py,
        camera.position.z - pz,
      );
      // side = tangent × view
      let sx = ty * this.view.z - tz * this.view.y,
        sy = tz * this.view.x - tx * this.view.z,
        sz = tx * this.view.y - ty * this.view.x;
      const len = Math.hypot(sx, sy, sz) || 1;
      const w = (RADIUS * 0.9 * (1 - i / TRAIL)) / len;
      sx *= w;
      sy *= w;
      sz *= w;
      position.setXYZ(i * 2, px + sx, py + sy, pz + sz);
      position.setXYZ(i * 2 + 1, px - sx, py - sy, pz - sz);
    }
    position.needsUpdate = true;
  }
  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
    });
  }
}
