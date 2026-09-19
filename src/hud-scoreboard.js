import { phaseBadge, possessionShare } from "./hud-format.js";

const $ = (id) => document.getElementById(id);
const HALF_LABEL = { 1: "1ST HALF", 2: "2ND HALF" };

// Score bug, event badge and the brief half-time graphic. DOM writes happen only
// when the displayed value actually changes.
export class Scoreboard {
  constructor() {
    this.shown = {};
    this.badgeKey = null;
    this.badgeTimer = 0;
  }
  reset() {
    this.shown = {};
    this.badgeKey = null;
    clearTimeout(this.badgeTimer);
    $("phase-badge").hidden = true;
    $("halftime").hidden = true;
  }
  write(id, value) {
    if (this.shown[id] === value) return false;
    this.shown[id] = value;
    $(id).textContent = value;
    return true;
  }
  update(sim) {
    const [home, away] = sim.score;
    if (this.write("score-home", String(home))) this.bump("score-home");
    if (this.write("score-away", String(away))) this.bump("score-away");
    const minute = `${sim.clock.minute}'`;
    this.write("clock-minute", minute);
    this.write(
      "clock-half",
      sim.phase === "fulltime"
        ? "FULL-TIME"
        : sim.phase === "halftime"
          ? "HALF-TIME"
          : (HALF_LABEL[sim.clock.half] ?? ""),
    );
    const [ph, pa] = possessionShare(sim.stats);
    if (this.shown.possession !== ph) {
      this.shown.possession = ph;
      $("poss-home").style.flexGrow = String(Math.max(ph, 1));
      $("poss-away").style.flexGrow = String(Math.max(pa, 1));
      $("poss-home-label").textContent = ph;
      $("poss-away-label").textContent = pa;
    }
    this.badge(sim);
    const halftime = sim.phase === "halftime";
    if ($("halftime").hidden === halftime) {
      $("halftime").hidden = !halftime;
      if (halftime) $("halftime-score").textContent = `${home} – ${away}`;
    }
  }
  bump(id) {
    if (this.shown.ready !== true) return; // no animation for the initial 0–0
    const element = $(id);
    // Broadcast score flip.
    element.classList.remove("flip");
    void element.offsetWidth;
    element.classList.add("flip");
  }
  badge(sim) {
    this.shown.ready = true;
    // Half-time has its own centre graphic; one announcement is enough.
    const next = sim.phase === "halftime" ? null : phaseBadge(sim);
    // Re-announce when a new restart of the same type follows the previous one.
    const key = next
      ? `${next.text}:${sim.score.join("-")}:${sim.restart ? `${sim.restart.x},${sim.restart.y}` : ""}:${sim.clock.half}`
      : null;
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    const element = $("phase-badge");
    clearTimeout(this.badgeTimer);
    if (!next) {
      // Let a short announcement finish instead of cutting it off instantly.
      this.badgeTimer = setTimeout(() => (element.hidden = true), 500);
      return;
    }
    element.textContent = next.text;
    element.dataset.tone = next.tone;
    element.hidden = false;
    element.classList.remove("announce");
    void element.offsetWidth;
    element.classList.add("announce");
    if (next.tone === "restart")
      this.badgeTimer = setTimeout(() => (element.hidden = true), 2600);
  }
}
