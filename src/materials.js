import * as THREE from "three";
import { renderProfile } from "./render-profile.js";

// Every texture/HDR goes through one manager so `MatchScene.ready` can wait for all of them.
export const assetManager = new THREE.LoadingManager();
let idle = true;
const waiting = new Set();
assetManager.onStart = () => {
  idle = false;
};
assetManager.onLoad = () => {
  idle = true;
  for (const resolve of waiting) resolve();
  waiting.clear();
};
assetManager.onError = (url) =>
  console.warn("JevBall asset failed to load:", url);
export function assetsReady() {
  return idle
    ? Promise.resolve()
    : new Promise((resolve) => waiting.add(resolve));
}

export const materials = new Map();
const loader = new THREE.TextureLoader(assetManager);
const maps = new Map();

function texture(name, kind) {
  const key = `${name}-${kind}`;
  if (!maps.has(key)) {
    const value = loader.load(`/textures/${key}.jpg`);
    value.wrapS = value.wrapT = THREE.RepeatWrapping;
    value.anisotropy = renderProfile.anisotropy;
    if (kind === "color") value.colorSpace = THREE.SRGBColorSpace;
    maps.set(key, value);
  }
  return maps.get(key);
}

// PBR set from public/textures. `metersPerTile` is consumed by metricUV().
export function pbr(name, tint = "#ffffff", metersPerTile = 3, options = {}) {
  const key = `${name}:${tint}:${metersPerTile}:${options.vertexColors ? "v" : ""}`;
  if (!materials.has(key)) {
    const material = new THREE.MeshStandardMaterial({
      color: tint,
      map: texture(name, "color"),
      normalMap: texture(name, "normal"),
      roughnessMap: texture(name, "roughness"),
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.95,
      metalness: 0,
      ...options,
    });
    material.userData.metersPerTile = metersPerTile;
    materials.set(key, material);
  }
  return materials.get(key);
}

// The CC0 grass scan is a mossy meadow. A match lawn keeps its grain (luminance,
// normal and roughness maps) but takes a clean turf hue.
export function lawn(metersPerTile = 4) {
  const key = `lawn:${metersPerTile}`;
  if (materials.has(key)) return materials.get(key);
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#4f9a3c";
  ctx.fillRect(0, 0, size, size);
  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderProfile.anisotropy;
  new THREE.ImageLoader(assetManager).load(
    "/textures/grass-color.jpg",
    (image) => {
      ctx.drawImage(image, 0, 0, size, size);
      const pixels = ctx.getImageData(0, 0, size, size);
      const d = pixels.data;
      let mean = 0;
      for (let i = 0; i < d.length; i += 4)
        mean += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      mean /= d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 - mean) / 255;
        // Scan luminance for the broad grain + per-pixel noise for blades up close.
        const k =
          1 +
          Math.max(-0.13, Math.min(0.13, l * 0.8)) +
          (Math.random() - 0.5) * 0.16;
        d[i] = 74 * k;
        d[i + 1] = 148 * k;
        d[i + 2] = 58 * k;
      }
      ctx.putImageData(pixels, 0, 0);
      map.needsUpdate = true;
    },
  );
  const material = new THREE.MeshStandardMaterial({
    map,
    normalMap: texture("grass", "normal"),
    roughnessMap: texture("grass", "roughness"),
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  material.userData.metersPerTile = metersPerTile;
  materials.set(key, material);
  return material;
}

export function flat(color, options = {}) {
  const key = `flat:${color}:${JSON.stringify(options)}`;
  if (!materials.has(key))
    materials.set(
      key,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.75,
        metalness: 0,
        ...options,
      }),
    );
  return materials.get(key);
}

// One material for all merged, vertex-painted static props and for player bodies.
export function painted(name = "props", options = {}) {
  const key = `painted:${name}`;
  if (!materials.has(key))
    materials.set(
      key,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.78,
        metalness: 0,
        ...options,
      }),
    );
  return materials.get(key);
}

// UVs measured in metres, so maps keep the same grain size on every surface.
export function metricUV(geometry, material) {
  const scale = material?.userData?.metersPerTile;
  if (!scale) return geometry;
  const position = geometry.attributes.position,
    normal = geometry.attributes.normal;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = Math.abs(normal.getX(i)),
      y = Math.abs(normal.getY(i)),
      z = Math.abs(normal.getZ(i));
    uv[i * 2] = (x > y && x > z ? position.getZ(i) : position.getX(i)) / scale;
    uv[i * 2 + 1] =
      (y >= x && y >= z ? position.getZ(i) : position.getY(i)) / scale;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

const scratch = new THREE.Color();
// Bake a flat colour into a geometry so many parts can merge into one draw call.
export function paint(geometry, color) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  scratch.set(color);
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (!g.attributes.uv)
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(count * 2), 2),
    );
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const name of Object.keys(g.attributes))
    if (!["position", "normal", "uv", "color"].includes(name))
      g.deleteAttribute(name);
  return g;
}

// Condensed display stack: the pages load Barlow Condensed; the rest cover a canvas drawn before it arrives.
export const FONT =
  '"Barlow Condensed", "Arial Narrow", "Helvetica Neue Condensed", Impact, sans-serif';

export function canvasTexture(width, height, draw, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderProfile.anisotropy;
  Object.assign(map, options);
  map.userData.redraw = () => {
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
    map.needsUpdate = true;
  };
  map.userData.redraw();
  return map;
}

export function disposeMaterials() {
  for (const material of materials.values()) {
    for (const key of [
      "map",
      "normalMap",
      "roughnessMap",
      "emissiveMap",
      "alphaMap",
    ])
      material[key]?.dispose();
    material.dispose();
  }
  materials.clear();
  for (const map of maps.values()) map.dispose();
  maps.clear();
}
