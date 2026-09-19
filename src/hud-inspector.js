import {
  decisionSummary,
  highlightJson,
  prettyJson,
  sessionSummary,
} from "./hud-format.js";

const $ = (id) => document.getElementById(id);

const DESCRIPTIONS = {
  request:
    "Exact Jev API payload of the latest batch: the match state once, then one choice question per player whose decision was due. Candidate geometry and physics stay local.",
  response:
    "What came back for that batch: a choice and a probability per option for every player, token usage, latency and cost.",
  decisions:
    "Every player's latest decision: who decided (jev, local policy or a reflex rule), the probabilities, and what the local policy would have picked.",
  match:
    "The full simulation snapshot: clock, phase, score, ball, all 22 players, stats and recent events.",
  session:
    "Telemetry for this browser session. Cost is estimated from Jev-reported input tokens and the configured price; it accumulates across matches.",
};

// "Under the hood" dialog. `source()` returns { sim, loop, mode, pricing, seed }.
export class Inspector {
  constructor(source, { onOpen } = {}) {
    this.source = source;
    this.tab = "request";
    this.frozen = false;
    this.dialog = $("json-dialog");
    $("scene-json").onclick = () => {
      onOpen?.();
      this.open();
    };
    $("close-json").onclick = () => this.dialog.close();
    // Click on the backdrop closes, like every other sheet in the app.
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    for (const button of this.dialog.querySelectorAll("[data-tab]"))
      button.onclick = () => this.select(button.dataset.tab);
    $("freeze-json").onclick = () => {
      this.frozen = !this.frozen;
      this.syncFreeze();
    };
    $("copy-json").onclick = () => this.copy();
    $("download-json").onclick = () => this.download();
    this.select("request");
  }
  get isOpen() {
    return this.dialog.open;
  }
  open(tab) {
    if (tab) this.select(tab);
    if (!this.dialog.open) this.dialog.showModal();
    this.render(true);
  }
  select(tab) {
    this.tab = tab;
    this.frozen = false;
    this.syncFreeze();
    for (const button of this.dialog.querySelectorAll("[data-tab]")) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    $("json-description").textContent = DESCRIPTIONS[tab];
    if (this.dialog.open) this.render(true);
  }
  syncFreeze() {
    $("freeze-json").textContent = this.frozen ? "Resume" : "Freeze";
    $("json-live").textContent = this.frozen ? "FROZEN" : "LIVE · 4 Hz";
  }
  data() {
    const { sim, loop, mode, pricing, seed } = this.source();
    const last = loop?.last;
    if (this.tab === "request") {
      const request = last?.response?.request ?? last?.request;
      if (request) return request;
      return {
        status:
          mode === "jev"
            ? "Waiting for the first Jev batch…"
            : "Running on the local policy: no Jev request is being made. With TYPESAFE_API_KEY set, this tab shows the exact payload of every batch.",
        shared_state_that_would_be_sent: sim.sharedState?.() ?? null,
      };
    }
    if (this.tab === "response") {
      if (!last?.response)
        return {
          status:
            mode === "jev"
              ? "Waiting for the first Jev response…"
              : "No Jev responses: players are using the local policy.",
          last_error: loop?.lastError ?? null,
        };
      const { request: _echo, ...response } = last.response;
      return { ...response, last_error: loop?.lastError ?? null };
    }
    if (this.tab === "decisions") return decisionSummary(sim);
    if (this.tab === "match") return sim.snapshot();
    return sessionSummary(loop?.tally, {
      mode,
      seed,
      pricing: pricing ?? null,
      last_error: loop?.lastError ?? null,
    });
  }
  render(force = false) {
    if (!this.dialog.open || (this.frozen && !force)) return;
    const content = $("json-content");
    // Do not yank the text away while the user is selecting it.
    const selection = window.getSelection?.();
    if (
      !force &&
      selection &&
      !selection.isCollapsed &&
      content.contains(selection.anchorNode)
    )
      return;
    let text;
    try {
      text = prettyJson(this.data());
    } catch (error) {
      text = prettyJson({ error: String(error?.message || error) });
    }
    if (text === this.lastText) return;
    this.lastText = text;
    content.innerHTML = highlightJson(text);
  }
  async copy() {
    // Copy exactly the snapshot on screen, including when frozen.
    const text = $("json-content").textContent;
    const button = $("copy-json");
    clearTimeout(this.copyTimer);
    button.disabled = true;
    try {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const field = document.createElement("textarea");
        field.value = text;
        field.readOnly = true;
        field.style.cssText = "position:fixed;left:-9999px;top:0";
        this.dialog.append(field);
        try {
          field.select();
          if (!document.execCommand("copy")) throw Error("Clipboard unavailable");
        } finally {
          field.remove();
        }
      }
      $("copy-json-label").textContent = "Copied!";
    } catch {
      this.frozen = true;
      this.syncFreeze();
      const range = document.createRange();
      range.selectNodeContents($("json-content"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      $("copy-json-label").textContent = "Press ⌘C / Ctrl+C";
    } finally {
      button.disabled = false;
      button.focus({ preventScroll: true });
      this.copyTimer = setTimeout(() => {
        $("copy-json-label").textContent = "Copy";
      }, 3000);
    }
  }
  download() {
    const text = $("json-content").textContent;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `jevball-${this.tab}-${this.source().seed}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
