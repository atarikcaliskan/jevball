// Thumbstick + Pass / Shoot / Switch buttons, shown on coarse pointers while
// the user controls a player.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TouchControls {
  constructor(root, canPlay, { onSwitch } = {}) {
    this.root = root;
    this.stick = root.querySelector(".touch-stick");
    this.buttons = [...root.querySelectorAll("[data-touch]")];
    this.canPlay = canPlay;
    this.onSwitch = onSwitch;
    this.media = matchMedia("(pointer: coarse)");
    this.controller = new AbortController();
    this.x = this.y = 0;
    this.sprint = false;
    this.flags = { pass: false, shoot: false };
    this.pointers = new Map();
    const listen = (element, name, handler) =>
      element.addEventListener(name, handler, {
        signal: this.controller.signal,
      });
    for (const element of [this.stick, ...this.buttons]) {
      listen(element, "pointerdown", (event) => {
        if (event.button !== 0 || !this.canPlay() || this.pointers.has(element))
          return;
        event.preventDefault();
        this.pointers.set(element, event.pointerId);
        element.setPointerCapture(event.pointerId);
        element.classList.add("held");
        if (element === this.stick) {
          const rect = element.getBoundingClientRect();
          this.origin = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
          this.radius = rect.width * 0.32;
          this.move(event);
        } else {
          const action = element.dataset.touch;
          if (action === "switch") this.onSwitch?.();
          else this.flags[action] = true;
        }
      });
      listen(element, "pointermove", (event) => {
        if (
          element === this.stick &&
          this.pointers.get(element) === event.pointerId
        )
          this.move(event);
      });
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
        listen(element, name, (event) => {
          if (this.pointers.get(element) === event.pointerId)
            this.release(element);
        });
      listen(element, "contextmenu", (event) => event.preventDefault());
    }
    listen(window, "blur", () => this.reset());
    listen(window, "resize", () => this.reset());
    listen(document, "visibilitychange", () => this.reset());
    listen(this.media, "change", () => this.reset());
  }
  get available() {
    return this.media.matches;
  }
  get active() {
    return this.x !== 0 || this.y !== 0;
  }
  // Consume a one-shot button press.
  take(action) {
    const was = this.flags[action];
    this.flags[action] = false;
    return was;
  }
  move(event) {
    if (!this.canPlay()) {
      this.reset();
      return;
    }
    let x = (event.clientX - this.origin.x) / this.radius;
    let y = (event.clientY - this.origin.y) / this.radius;
    const length = Math.max(1, Math.hypot(x, y));
    x /= length;
    y /= length;
    const axis = (v) => Math.sign(v) * clamp((Math.abs(v) - 0.12) / 0.6, 0, 1);
    this.x = axis(x);
    this.y = axis(-y); // screen-up is positive
    this.sprint = Math.hypot(x, y) > 0.92;
    this.stick.classList.toggle("sprinting", this.sprint);
    this.stick.style.setProperty("--stick-x", `${x * this.radius}px`);
    this.stick.style.setProperty("--stick-y", `${y * this.radius}px`);
  }
  release(element) {
    const id = this.pointers.get(element);
    this.pointers.delete(element);
    if (id !== undefined && element.hasPointerCapture?.(id))
      element.releasePointerCapture(id);
    element.classList.remove("held");
    if (element === this.stick) {
      this.x = this.y = 0;
      this.sprint = false;
      element.classList.remove("sprinting");
      element.style.setProperty("--stick-x", "0px");
      element.style.setProperty("--stick-y", "0px");
    }
  }
  reset() {
    this.release(this.stick);
    for (const button of this.buttons) this.release(button);
    this.flags.pass = this.flags.shoot = false;
  }
  sync() {
    const disabled = !this.available || !this.canPlay();
    if (disabled && this.pointers.size) this.reset();
    if (this.root.hidden !== disabled) this.root.hidden = disabled;
  }
  dispose() {
    this.reset();
    this.controller.abort();
  }
}
