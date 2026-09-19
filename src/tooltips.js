// One shared tooltip element for every HUD control (hover and keyboard focus).
export class Tooltips {
  constructor() {
    this.element = document.createElement("div");
    this.element.id = "control-tooltip";
    this.element.role = "tooltip";
    this.element.hidden = true;
    document.body.append(this.element);
    this.events = new AbortController();
    const on = (target, type, handler) =>
      target.addEventListener(type, handler, { signal: this.events.signal });
    on(document, "pointerover", (event) => {
      if (event.pointerType === "touch") return;
      const target = event.target.closest?.("[data-tooltip]");
      if (target && !target.contains(event.relatedTarget)) this.show(target);
    });
    on(document, "pointerout", (event) => {
      if (
        this.target?.contains(event.target) &&
        !this.target.contains(event.relatedTarget)
      )
        this.hide();
    });
    on(document, "focusin", (event) => {
      const target = event.target.closest?.("[data-tooltip]");
      if (target && target.matches(":focus-visible")) this.show(target);
    });
    on(document, "focusout", () => this.hide());
    on(document, "pointerdown", () => this.hide());
    on(document, "keydown", (event) => {
      if (event.key === "Escape") this.hide();
    });
    on(window, "resize", () => this.hide());
  }
  set(target, label) {
    if (!target) return;
    target.dataset.tooltip = label;
    target.removeAttribute("title");
    if (this.target === target && !this.element.hidden) this.place();
  }
  adopt(root = document) {
    for (const element of root.querySelectorAll("[title]"))
      this.set(element, element.title);
  }
  show(target) {
    this.hide();
    this.target = target;
    this.timer = setTimeout(() => {
      // Tooltips inside a modal must live in the top layer with it.
      const host = target.closest("dialog[open]") || document.body;
      if (this.element.parentNode !== host) host.append(this.element);
      target.setAttribute("aria-describedby", this.element.id);
      this.element.hidden = false;
      this.place();
    }, 180);
  }
  place() {
    this.element.textContent = this.target.dataset.tooltip;
    const target = this.target.getBoundingClientRect();
    const tip = this.element.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        innerWidth - tip.width - 8,
        target.left + (target.width - tip.width) / 2,
      ),
    );
    const top =
      target.top >= tip.height + 16
        ? target.top - tip.height - 8
        : target.bottom + 8;
    this.element.style.left = `${left}px`;
    this.element.style.top = `${Math.max(8, Math.min(innerHeight - tip.height - 8, top))}px`;
  }
  hide() {
    clearTimeout(this.timer);
    this.target?.removeAttribute("aria-describedby");
    this.target = null;
    this.element.hidden = true;
  }
  dispose() {
    this.hide();
    this.events.abort();
    this.element.remove();
  }
}
