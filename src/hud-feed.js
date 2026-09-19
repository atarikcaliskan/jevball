import { describeChoice, escapeHtml, pct } from "./hud-format.js";

const MAX_ROWS = 8;
const NEAR_BALL_M = 18;
const MIN_GAP_MS = 220; // keeps the ticker readable when many players decide at once
const SKIP_EVENTS = new Set(["decision", "pass"]);
const EVENT_MARK = {
  goal: "GOAL",
  shot: "SHOT",
  save: "SAVE",
  tackle: "TACKLE",
  interception: "INTERCEPT",
  corner: "CORNER",
  throw_in: "THROW-IN",
  goal_kick: "GOAL KICK",
  kickoff: "KICK-OFF",
  halftime: "HALF-TIME",
  fulltime: "FULL-TIME",
};

// Commentary rail: minute-stamped decisions of players around the ball + match events.
export class Feed {
  constructor(list, { teams, onPick }) {
    this.list = list;
    this.teams = teams;
    this.seen = new Map(); // player id -> last decision key shown/considered
    this.choices = new Map(); // player id -> last choice that made the feed
    this.lastEvent = null;
    this.lastRowAt = 0;
    this.queue = [];
    list.addEventListener("click", (event) => {
      const id = event.target.closest("[data-player]")?.dataset.player;
      if (id) onPick?.(id);
    });
  }
  reset() {
    this.seen.clear();
    this.choices.clear();
    this.lastEvent = null;
    this.queue.length = 0;
    this.list.replaceChildren();
  }
  // Returns true when rows were added.
  update(sim, loop, now) {
    this.collectEvents(sim);
    this.collectDecisions(sim, loop);
    if (!this.queue.length) return false;
    // Events always go out; decisions are paced so rows can be read.
    let added = false;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.kind === "decision" && now - this.lastRowAt < MIN_GAP_MS) break;
      this.queue.shift();
      this.push(next.html, next.className);
      this.lastRowAt = now;
      added = true;
    }
    if (this.queue.length > 6)
      this.queue = this.queue.filter((row) => row.kind === "event").slice(-6);
    return added;
  }
  collectEvents(sim) {
    const events = sim.events ?? [];
    if (!events.length) return;
    let start = this.lastEvent ? events.lastIndexOf(this.lastEvent) + 1 : 0;
    // First sight of a running match: do not replay its whole history.
    if (!this.lastEvent) start = Math.max(0, events.length - 3);
    this.lastEvent = events.at(-1);
    for (const event of events.slice(start)) {
      if (SKIP_EVENTS.has(event.type)) continue;
      const color =
        event.team === 0 || event.team === 1
          ? this.teams[event.team].colors.shirt
          : "#a9b5ab";
      this.queue.push({
        kind: "event",
        className: `feed-row event ${event.type}`,
        html: `<span class="feed-minute">${event.minute ?? 0}'</span><i class="feed-bar" style="background:${color}"></i><b class="feed-mark">${EVENT_MARK[event.type] ?? escapeHtml(event.type)}</b><span class="feed-text">${escapeHtml(event.text ?? "")}</span>`,
      });
    }
  }
  collectDecisions(sim, loop) {
    const ball = sim.ball;
    for (const p of sim.players) {
      const d = p.decision;
      if (!d || p.isHuman) continue;
      const key = `${d.batchId}:${d.at}:${d.choice}`;
      if (this.seen.get(p.id) === key) continue;
      this.seen.set(p.id, key);
      const carrier = ball.ownerId === p.id;
      if (!carrier && Math.hypot(p.x - ball.x, p.y - ball.y) > NEAR_BALL_M)
        continue;
      // Reflexes and repeats of the same choice are not news.
      if (d.source === "rule" && !carrier) continue;
      if (this.choices.get(p.id) === d.choice && !carrier) continue;
      this.choices.set(p.id, d.choice);
      const latency =
        d.latencyMs ??
        d.latency_ms ??
        (d.source === "jev" ? loop?.tally?.latencies?.at(-1) : null);
      const color = this.teams[p.team].colors.shirt;
      this.queue.push({
        kind: "decision",
        className: `feed-row decision${carrier ? " carrier" : ""}`,
        html: `<span class="feed-minute">${sim.clock?.minute ?? 0}'</span><i class="feed-bar" style="background:${color}"></i><button data-player="${escapeHtml(p.id)}" aria-label="Focus ${escapeHtml(p.id)}"><b>${escapeHtml(p.id)}</b><span class="feed-role">${escapeHtml(p.role)}</span></button><span class="feed-text">${escapeHtml(describeChoice(d.choice))}</span><span class="feed-prob">${pct(d.probabilities?.[d.choice])}</span><span class="source-badge" data-source="${escapeHtml(d.source)}">${escapeHtml(d.source)}${Number.isFinite(latency) && d.source === "jev" ? ` <em>${Math.round(latency)} ms</em>` : ""}</span>`,
      });
    }
  }
  push(html, className) {
    const row = document.createElement("li");
    row.className = className;
    row.innerHTML = html;
    this.list.prepend(row);
    while (this.list.children.length > MAX_ROWS) this.list.lastChild.remove();
  }
}
