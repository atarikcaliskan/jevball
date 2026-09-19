import { KIND_LABEL, escapeHtml, pct } from "./hud-format.js";

const $ = (id) => document.getElementById(id);
const MAX_OPTIONS = 6;
const ROLE_NAME = {
  GK: "Goalkeeper",
  LB: "Left back",
  CB: "Centre back",
  RB: "Right back",
  LWB: "Left wing-back",
  RWB: "Right wing-back",
  DM: "Holding midfielder",
  CM: "Central midfielder",
  LM: "Left midfielder",
  RM: "Right midfielder",
  AM: "Attacking midfielder",
  LW: "Left winger",
  RW: "Right winger",
  ST: "Striker",
};

// Lower-third player graphic: shirt number, role, and the latest decision with
// every option as a probability bar.
export class PlayerCard {
  constructor({ teams }) {
    this.teams = teams;
    this.key = null;
  }
  reset() {
    this.key = null;
    $("player-card").hidden = true;
  }
  update(sim, focusId) {
    const player = focusId ? sim.player(focusId) : null;
    const card = $("player-card");
    if (!player) {
      if (!card.hidden) card.hidden = true;
      this.key = null;
      return;
    }
    const d = player.decision;
    const key = `${player.id}:${player.isHuman}:${d?.batchId}:${d?.at}:${d?.choice}:${player.pending}`;
    if (key === this.key && !card.hidden) return;
    this.key = key;
    card.hidden = false;
    const team = this.teams[player.team];
    card.style.setProperty("--team", team.colors.shirt);
    card.classList.toggle("you", !!player.isHuman);
    $("pc-number").textContent = player.number;
    $("pc-name").textContent = ROLE_NAME[player.role] ?? player.role;
    $("pc-team").textContent = `${player.id} · ${player.role} · ${team.name}`;
    if (player.isHuman) {
      $("pc-kind").textContent = "You are in control";
      $("pc-source").hidden = true;
      $("pc-confidence").textContent = "";
      $("pc-options").innerHTML =
        `<p class="pc-empty">No model decisions while you play this player. Press <kbd>J</kbd> to hand control back to Jev.</p>`;
      card.classList.add("no-legend");
      return;
    }
    if (!d) {
      $("pc-kind").textContent = "Waiting for a decision";
      $("pc-source").hidden = true;
      $("pc-confidence").textContent = "";
      $("pc-options").innerHTML =
        `<p class="pc-empty">${escapeHtml(player.intent?.label || "No decision yet.")}</p>`;
      card.classList.add("no-legend");
      return;
    }
    card.classList.remove("no-legend");
    $("pc-kind").textContent = KIND_LABEL[d.kind] ?? d.kind ?? "";
    $("pc-source").hidden = false;
    $("pc-source").dataset.source = d.source;
    $("pc-source").textContent = d.source;
    $("pc-confidence").textContent = Number.isFinite(d.confidence)
      ? `${pct(d.confidence)} confident`
      : player.pending
        ? "asking…"
        : "";
    const state = player.lastDecisionState;
    const localPick =
      state?.batch_id === d.batchId
        ? state.local?.choice
        : d.source === "local"
          ? d.choice
          : null;
    const options = d.options ?? {};
    const ids = Object.keys(d.probabilities ?? options);
    if (!ids.includes(d.choice)) ids.push(d.choice);
    const rows = ids
      .map((id) => ({
        id,
        p: d.probabilities?.[id] ?? (id === d.choice ? 1 : 0),
        label: options[id]?.label ?? id.replace(/_/g, " "),
      }))
      .sort((a, b) => b.p - a.p || (a.id === d.choice ? -1 : 1));
    let shown = rows.slice(0, MAX_OPTIONS);
    for (const must of [d.choice, localPick])
      if (must && !shown.some((r) => r.id === must)) {
        const row = rows.find((r) => r.id === must);
        if (row) shown[shown.length - 1] = row;
      }
    const hiddenCount = rows.length - shown.length;
    $("pc-options").innerHTML =
      shown
        .map(
          (row) =>
            `<div class="pc-option${row.id === d.choice ? " chosen" : ""}"><span class="pc-label" title="${escapeHtml(row.label)}">${row.id === localPick ? '<i class="legend-dot" title="Local policy\'s pick"></i>' : ""}${escapeHtml(row.label)}</span><span class="pc-pct">${pct(row.p)}</span><span class="pc-bar"><i style="width:${Math.max(2, Math.round(row.p * 100))}%"></i></span></div>`,
        )
        .join("") +
      (hiddenCount > 0
        ? `<span class="pc-more">+${hiddenCount} more in Under the hood → Decisions</span>`
        : "");
  }
}
