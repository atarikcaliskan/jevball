export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, n = 2) => {
  const k = 10 ** n;
  return Math.round(v * k) / k;
};
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

// Small, fast, well-distributed 32-bit generator; every random draw in the sim goes through one of these.
export function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngRange = (r, a, b) => a + (b - a) * r();
// Box–Muller; one draw pair per call keeps the stream simple to reason about.
export const rngNormal = (r) =>
  Math.sqrt(-2 * Math.log(1 - r() || 1e-9)) * Math.cos(2 * Math.PI * r());

// Closest point on segment ab to p: { d, t, x, y } with t in [0,1] along a→b.
export function pointSegment(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  const x = a.x + dx * t,
    y = a.y + dy * t;
  return { d: Math.hypot(p.x - x, p.y - y), t, x, y };
}
export const pointSegmentDistance = (p, a, b) => pointSegment(p, a, b).d;

export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const angleDiff = (a, b) => wrapAngle(b - a);
export const angleTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
export const turnToward = (a, b, maxStep) =>
  a + clamp(angleDiff(a, b), -maxStep, maxStep);
export const deg = (rad) => (rad * 180) / Math.PI;
