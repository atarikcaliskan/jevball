// Builds the exact Jev payload. Billing is input tokens only, and Jev's
// tokenizer (measured live) charges about one token per *character* of JSON
// numbers and punctuation but only one per ~4.3 characters of English. So:
//   - each option's facts travel as a short worded string in `criteria`
//     ("dist 12 progress 7 lane 3.4 success 87 ..."), which is where the API
//     wants option descriptions anyway: no column legends, no repeated ids, no
//     null padding, and a human can still read it in the inspector;
//   - numbers carry no pointless digits: whole metres, percent instead of 0.xx,
//     one decimal only for times and small clearances, defaults omitted;
//   - the 22 players are one "id role x y" line each side instead of 22 arrays;
//   - guidance lives once in `state.playbook`, keyed by decision kind, and only
//     the kinds asked in this batch are sent; each question just points at it.
// The HUD keeps the long human label; Jev never pays for it.
const PERCENT = /^(xg|danger)$|_p$/;
const FINE =
  /^(lane_clear_m|pressure_m|keeper_off_m|offside_margin_m|height_m)$/;
const WORDS = {
  lane_clear_m: "lane",
  receiver_space_m: "space",
  nearest_teammate_m: "mate",
};
const word = (key) => WORDS[key] ?? key.replace(/_(m|s|p|deg)$/, "");

export function compact(value, key = "") {
  if (!Number.isFinite(value)) return null;
  if (PERCENT.test(key)) return Math.round(value * 100);
  const scale =
    key.endsWith("_s") || (FINE.test(key) && Math.abs(value) < 10) ? 10 : 1;
  return Math.round(value * scale) / scale || 0; // no -0
}

export const PLAYBOOK = {
  all: "Each question is one footballer choosing for himself. Trailing late: take more risk. Leading late: keep the ball and stay compact.",
  carrier:
    "You have the ball: pick what most likely leads to a goal without losing the ball cheaply. A shot with good xg beats everything; otherwise prefer forward passes and through balls with high success into space; dribble only into open space; recycle backwards under pressure; clear only under pressure near your own goal.",
  attack:
    "Your team has the ball, you do not: help the carrier. Offer a safe passing lane near him, stretch wide, or run behind the last line when there is space; keep shape when far from play.",
  defend:
    "The opponent has the ball: stop the attack. Press only if you are closest (rank 1); otherwise mark free dangerous opponents, cover the path to goal or keep shape; never leave the goal side open.",
  loose:
    "The ball is loose: chase only if your eta beats opp_eta and no teammate is clearly earlier (mate_eta); otherwise cover or keep shape.",
  keeper:
    "You are the goalkeeper: protect the goal first. Stay set for shots; rush or claim only when you clearly reach the ball first (eta well below opp_eta); with the ball, distribute safely.",
  restart:
    "You take the restart: choose the pass that keeps possession and moves your team forward.",
};

// Features that repeat the player's own line or can never decide anything for
// that action: offside passes are never offered, so the margin only matters for runs.
const REDUNDANT = {
  pass: ["offside_margin_m"],
  through: ["offside_margin_m"],
  shoot: ["pressure_m"],
  clear: ["pressure_m"],
  hold: ["pressure_m"],
};
const NO_ARRIVAL = 9; // the sim's "nobody gets there" eta sentinel is 9.9 s

// "dist 12 progress 7 lane 3.4 space 5 success 87 eta 0.9 opp_eta 2"
export function describeOption(id, o) {
  const parts = [];
  // pass_h7 / mark_a9 already name their target; a press or cross does not.
  if (o.target_id != null && !id.endsWith(`_${o.target_id}`))
    parts.push(`on ${o.target_id}`);
  for (const [key, value] of Object.entries(o.features || {})) {
    if (REDUNDANT[o.action]?.includes(key)) continue;
    if (typeof value === "boolean") {
      if (value) parts.push(word(key));
      continue;
    }
    const n = compact(value, key);
    if (n === null || (/(opp|mate)_eta_s$/.test(key) && n >= NO_ARRIVAL))
      continue;
    parts.push(`${word(key)} ${n}`);
  }
  return parts.join(" ") || o.action;
}

function describeSelf(d) {
  // His position is already in state.players; the rest is what only he knows.
  const s = d.self ?? {},
    parts = [];
  if (s.has_ball && d.kind !== "carrier") parts.push("has the ball");
  for (const key of [
    "speed",
    "pressure_m",
    "goal_dist_m",
    // the shooting angle only matters to whoever can shoot
    ...(s.has_ball ? ["goal_angle_deg"] : []),
    "nearest_teammate_m",
  ]) {
    const n = compact(s[key], key);
    if (n !== null) parts.push(`${word(key)} ${n}`);
  }
  return parts.join(" ");
}

const roster = (players, prefix) =>
  players
    .filter(([id]) => id[0] === prefix)
    .map(([id, role, x, y]) => `${id} ${role} ${compact(x)} ${compact(y)}`)
    .join(", ");

// The complete, stateless API input. Arrow polylines (`path`), HUD labels and
// the local policy verdict (`local`) never leave the client: they cost tokens
// and the verdict would bias Jev toward the heuristic it is meant to replace.
export function prepareJevRequest({ shared, decisions }) {
  const questions = {},
    fixed = {},
    order = [],
    kinds = new Set();
  for (const d of decisions) {
    const ids = Object.keys(d.options);
    order.push(d.player_id);
    if (ids.length === 1) {
      fixed[d.player_id] = {
        choice: ids[0],
        probabilities: { [ids[0]]: 1 },
        confidence: 1,
        source: "only_option",
      };
      continue;
    }
    const kind = d.kind in PLAYBOOK ? d.kind : "attack";
    kinds.add(kind);
    questions[d.player_id] = {
      type: "choice",
      instructions: `You are ${d.player_id} (${d.team} ${d.role}), ${d.kind}: ${describeSelf(d)}. Choose per playbook.${kind}.`,
      criteria: Object.fromEntries(
        ids.map((id) => [id, describeOption(id, d.options[id])]),
      ),
    };
  }
  // Passing, crossing and restarts are read off the whole pitch, so on-ball
  // questions get all 22 positions. Off-ball options already carry every
  // distance that matters (measured live: the table cost ~225 tokens per call
  // and did not change what off-ball players chose).
  const onBall = decisions.some(
    (d) => questions[d.player_id] && (d.kind === "restart" || d.self?.has_ball),
  );
  const homeDir = shared.half === 2 ? -1 : 1;
  const b = shared.ball;
  const state = {
    units:
      "Metres, seconds; success, xg and danger are percent. Home is h1-h11, away a1-a11. " +
      (onBall
        ? `World: x along the pitch -52..52, y across -34..34, goals at x=±52 y=0, home attacks ${homeDir > 0 ? "+x" : "-x"} this half; players are 'id role x y'. `
        : "") +
      "Option facts: dist to the target, progress = metres gained toward the opponent goal, lane = how clear the ball's path is of opponents, " +
      "space = free space at the target, eta = time to get there (opp_eta/mate_eta = nearest opponent/teammate, absent = never), " +
      "rank 1 = closest of your team, pressure = nearest opponent, mate = nearest teammate.",
    match: {
      minute: shared.minute,
      half: shared.half,
      home: shared.score[0],
      away: shared.score[1],
      ...(shared.phase !== "play" && { phase: shared.phase }),
      ...(shared.restart && { restart: shared.restart }),
      possession: shared.possession ?? null,
    },
    ball: {
      x: compact(b.x),
      y: compact(b.y),
      ...(b.z >= 0.5 && { z: compact(b.z) }),
      // a carried ball moves with its owner; only a free ball has its own velocity
      ...(b.owner
        ? { owner: b.owner }
        : { vx: compact(b.vx), vy: compact(b.vy) }),
      ...(b.flight && { flight: b.flight }),
    },
    ...(onBall && {
      players: {
        home: roster(shared.players, "h"),
        away: roster(shared.players, "a"),
      },
    }),
    playbook: Object.fromEntries(
      ["all", ...kinds].map((kind) => [kind, PLAYBOOK[kind]]),
    ),
  };
  return { request: { model: "jev-latest", state, questions }, fixed, order };
}

// Jev documents probabilities for every criteria key. Anything else (unknown
// choice, missing or non-finite probability) is dropped so the caller falls
// back to the local policy for that player instead of acting on garbage.
export function expandJevAnswers(prepared, answers = {}) {
  const decisions = {},
    invalid = [];
  for (const id of prepared.order) {
    if (prepared.fixed[id]) {
      decisions[id] = prepared.fixed[id];
      continue;
    }
    const offered = Object.keys(prepared.request.questions[id].criteria);
    const answer = answers?.[id];
    const p = answer?.probabilities;
    if (
      !answer ||
      !offered.includes(answer.choice) ||
      !p ||
      typeof p !== "object" ||
      !offered.every((o) => Number.isFinite(p[o]) && p[o] >= 0 && p[o] <= 1)
    ) {
      invalid.push(id);
      continue;
    }
    decisions[id] = {
      choice: answer.choice,
      probabilities: Object.fromEntries(offered.map((o) => [o, p[o]])),
      confidence: Number.isFinite(answer.confidence)
        ? answer.confidence
        : p[answer.choice],
      source: "jev",
    };
  }
  return { decisions, invalid };
}

// Rough UI estimate only; billing uses the API's own usage numbers. Measured
// live on this payload: ~2 bytes per billed token, plus ~290 tokens per call.
export const estimateTokens = (request) =>
  Math.ceil(new TextEncoder().encode(JSON.stringify(request)).length / 2) + 290;
