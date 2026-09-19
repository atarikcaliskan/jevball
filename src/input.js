// Keyboard state for the human-controlled player. Pure helpers are exported
// separately so the camera-relative mapping can be checked without a DOM.

// Broadcast camera: three.z = sim.y and the camera sits on the +z side looking
// toward -z, so screen-right is +x and screen-up is -y in sim coordinates.
export const BROADCAST_BASIS = Object.freeze({
  right: Object.freeze({ x: 1, y: 0 }),
  forward: Object.freeze({ x: 0, y: -1 }),
});

const finite = (v) => Number.isFinite(v?.x) && Number.isFinite(v?.y);

export function usableBasis(basis) {
  if (!finite(basis?.right) || !finite(basis?.forward)) return BROADCAST_BASIS;
  const r = Math.hypot(basis.right.x, basis.right.y),
    f = Math.hypot(basis.forward.x, basis.forward.y);
  if (r < 1e-3 || f < 1e-3) return BROADCAST_BASIS;
  return {
    right: { x: basis.right.x / r, y: basis.right.y / r },
    forward: { x: basis.forward.x / f, y: basis.forward.y / f },
  };
}

// ix: screen right (+1) / left (-1); iy: screen up (+1) / down (-1).
// Returns a sim-space direction with length <= 1.
export function moveVector(ix, iy, basis) {
  const b = usableBasis(basis);
  let mx = b.right.x * ix + b.forward.x * iy,
    my = b.right.y * ix + b.forward.y * iy;
  const length = Math.hypot(mx, my);
  if (length > 1) {
    mx /= length;
    my /= length;
  }
  return { mx: Math.abs(mx) < 1e-6 ? 0 : mx, my: Math.abs(my) < 1e-6 ? 0 : my };
}

const MOVE_KEYS = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
export const isMoveKey = (code) => code in MOVE_KEYS;

export class HumanInput {
  constructor() {
    this.keys = new Set();
    this.queued = { pass: false, shoot: false };
  }
  press(code) {
    this.keys.add(code);
  }
  release(code) {
    this.keys.delete(code);
  }
  queue(action) {
    this.queued[action] = true;
  }
  clear() {
    this.keys.clear();
    this.queued.pass = this.queued.shoot = false;
  }
  axes() {
    let ix = 0,
      iy = 0;
    for (const code of this.keys) {
      const axis = MOVE_KEYS[code];
      if (axis) {
        ix += axis[0];
        iy += axis[1];
      }
    }
    return { ix: Math.sign(ix), iy: Math.sign(iy) };
  }
  // Writes sim.humanInput once per frame. `touch` is an optional TouchControls.
  apply(sim, basis, touch) {
    const out = sim.humanInput;
    if (!out) return;
    if (!sim.human) {
      out.mx = out.my = 0;
      out.sprint = false;
      this.queued.pass = this.queued.shoot = false;
      return;
    }
    let { ix, iy } = this.axes();
    let sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    if (!ix && !iy && touch?.active) {
      ix = touch.x;
      iy = touch.y;
      sprint ||= touch.sprint;
    }
    const { mx, my } = moveVector(ix, iy, basis);
    out.mx = mx;
    out.my = my;
    out.sprint = sprint;
    // One-shot flags: only ever raise them; the simulation lowers them.
    if (this.queued.pass || touch?.take("pass")) out.pass = true;
    if (this.queued.shoot || touch?.take("shoot")) out.shoot = true;
    this.queued.pass = this.queued.shoot = false;
  }
}
