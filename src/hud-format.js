// Pure formatting helpers shared by the HUD modules. No DOM: importable in Node.

export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export const pct = (p) =>
  Number.isFinite(p) ? `${Math.round(p * 100)}%` : "–";

export const money = (usd) => `$${(Number(usd) || 0).toFixed(6)}`;

// Hosted play credit: four decimals are enough to watch it tick down.
export const credit = (usd) =>
  `$${Math.max(0, Number(usd) || 0).toFixed(4)}`;

// How full the balance bar is and which colour it takes: "low" below 20 % of
// everything ever credited (granted + purchased), "out" once exhausted.
export function creditLevel(credits) {
  const c = credits ?? {};
  const total = (Number(c.granted_usd) || 0) + (Number(c.purchased_usd) || 0);
  const remaining = Math.max(0, Number(c.remaining_usd) || 0);
  const fraction = total > 0 ? Math.min(1, remaining / total) : 0;
  const tone =
    c.exhausted || !(remaining > 0) ? "out" : fraction < 0.2 ? "low" : "ok";
  return { fraction: tone === "out" ? 0 : fraction, tone };
}

// "Ada Lovelace" → "AL", "octocat" → "OC"
export function initials(name) {
  const words = String(name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters =
    words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

// "pass_h9" → "pass h9", "dribble_fwd" → "dribble fwd", "gk_rush" → "keeper rush"
const WORDS = { fwd: "forward", gk: "keeper" };
export function describeChoice(choice) {
  if (!choice) return "–";
  return String(choice)
    .split("_")
    .map((word) => WORDS[word] ?? word)
    .join(" ");
}

export const KIND_LABEL = {
  carrier: "On the ball",
  attack: "Attacking",
  defend: "Defending",
  loose: "Loose ball",
  keeper: "Goalkeeping",
  restart: "Taking restart",
};

export const SOURCE_LABEL = { jev: "jev", local: "local", rule: "rule" };

const RESTART_BADGE = {
  kickoff: "KICK-OFF",
  throw_in: "THROW-IN",
  corner: "CORNER",
  goal_kick: "GOAL KICK",
  free_kick: "FREE KICK",
};

// What the phase badge should read for the current sim state, or null.
export function phaseBadge(sim) {
  if (sim.phase === "goal") return { text: "GOAL", tone: "goal" };
  if (sim.phase === "halftime") return { text: "HALF-TIME", tone: "whistle" };
  if (sim.phase === "fulltime") return { text: "FULL-TIME", tone: "whistle" };
  if (sim.phase === "kickoff") return { text: "KICK-OFF", tone: "restart" };
  if (sim.phase === "restart" && sim.restart)
    return {
      text: RESTART_BADGE[sim.restart.type] ?? "RESTART",
      tone: "restart",
    };
  return null;
}

export function possessionShare(stats) {
  const [home = 0, away = 0] = stats?.possessionTime ?? [];
  const total = home + away;
  if (!(total > 0)) return [50, 50];
  const h = Math.round((home / total) * 100);
  return [h, 100 - h];
}

export const percentile = (values, q) => {
  if (!values?.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

export const average = (values) =>
  values?.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

// Session tab of the inspector + the cost tooltip.
export function sessionSummary(tally, extra = {}) {
  const t = tally ?? {};
  const calls = t.calls || 0;
  return {
    ...extra,
    jev_calls: calls,
    decisions: t.decisions || 0,
    jev_decisions: t.jevDecisions || 0,
    local_decisions: t.localDecisions || 0,
    stale_answers: t.stale || 0,
    errors: t.errors || 0,
    latency_ms: {
      average: Math.round(average(t.latencies)),
      p95: Math.round(percentile(t.latencies, 0.95)),
      samples: t.latencies?.length || 0,
    },
    tokens: {
      input: t.input || 0,
      output: t.output || 0,
      average_input_per_call: calls ? Math.round((t.input || 0) / calls) : 0,
    },
    request_bytes: {
      total: t.request_bytes || 0,
      average_per_call: calls ? Math.round((t.request_bytes || 0) / calls) : 0,
    },
    cost_usd: Number((t.cost || 0).toFixed(8)),
  };
}

// Decisions tab: one compact row per player.
export function decisionSummary(sim) {
  return sim.players.map((p) => {
    const d = p.decision;
    return {
      id: p.id,
      role: p.role,
      human: !!p.isHuman,
      pending: !!p.pending,
      intent: p.intent?.label ?? p.intent?.type ?? null,
      decision: d
        ? {
            kind: d.kind,
            choice: d.choice,
            label: d.label,
            source: d.source,
            confidence: d.confidence ?? null,
            probabilities: d.probabilities ?? null,
            local_choice:
              p.lastDecisionState?.batch_id === d.batchId
                ? (p.lastDecisionState.local?.choice ?? null)
                : null,
            latency_ms: d.latencyMs ?? null,
            at: d.at,
            batch_id: d.batchId,
          }
        : null,
    };
  });
}

export function statsRows(stats) {
  const s = stats ?? {};
  const pair = (key) => [s[key]?.[0] ?? 0, s[key]?.[1] ?? 0];
  const [ph, pa] = possessionShare(s);
  const shots = pair("shots"),
    onTarget = pair("onTarget"),
    passes = pair("passes"),
    completed = pair("passesCompleted");
  const completion = (i) =>
    passes[i] ? `${Math.round((completed[i] / passes[i]) * 100)}%` : "–";
  return [
    { label: "Possession", home: `${ph}%`, away: `${pa}%`, share: [ph, pa] },
    {
      label: "Shots (on target)",
      home: `${shots[0]} (${onTarget[0]})`,
      away: `${shots[1]} (${onTarget[1]})`,
      share: shots,
    },
    {
      label: "Passes",
      home: `${passes[0]} · ${completion(0)}`,
      away: `${passes[1]} · ${completion(1)}`,
      share: passes,
    },
    { label: "Tackles", home: pair("tackles")[0], away: pair("tackles")[1], share: pair("tackles") },
    { label: "Saves", home: pair("saves")[0], away: pair("saves")[1], share: pair("saves") },
    { label: "Corners", home: pair("corners")[0], away: pair("corners")[1], share: pair("corners") },
  ];
}

export function highlightJson(text) {
  return escapeHtml(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(
      /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g,
      (m) =>
        `<span class="${m.startsWith('"') ? (m.endsWith(":") ? "json-key" : "json-string") : /true|false|null/.test(m) ? "json-bool" : "json-number"}">${m}</span>`,
    );
}

// Indented JSON, but arrays of plain values stay on one line so tables such as
// the 22 player rows remain readable.
export function prettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /\[\s*((?:"(?:\\.|[^"\\])*"|-?\d[\d.eE+-]*|true|false|null)(?:,\s*(?:"(?:\\.|[^"\\])*"|-?\d[\d.eE+-]*|true|false|null))*)\s*\]/g,
    (_match, inner) =>
      `[${inner.replace(/("(?:\\.|[^"\\])*")|\s*\n\s*/g, (m, str) => str ?? " ")}]`,
  );
}
