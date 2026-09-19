import {
  createIcons,
  ArrowUpRight,
  Braces,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  Gauge,
  LogIn,
  LogOut,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCw,
  Gamepad2,
  Video,
  X,
} from "lucide";
import { escapeHtml } from "./hud-format.js";
import { SUPPORT_URL, SOURCE_URL } from "./support.js";

const icons = {
  ArrowUpRight,
  Braces,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  Gauge,
  LogIn,
  LogOut,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCw,
  Gamepad2,
  Video,
  X,
};

export const icon = (name) => `<i data-lucide="${name}"></i>`;
export const refreshIcons = () => createIcons({ icons });

// Brand glyphs for the creator links (lucide's brand icons are deprecated; simple monochrome paths instead).
const brandIcon = (d) =>
  `<svg class="brand-glyph" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="${d}"/></svg>`;
// Sign-in provider glyph for hud-auth.js ("github" | "google"), or "" when unknown.
export const providerGlyph = (provider) =>
  BRAND_PATHS[provider] ? brandIcon(BRAND_PATHS[provider]) : "";
const BRAND_PATHS = {
  google:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  x: "M17.75 3h3.07l-6.7 7.63L22 21h-6.17l-4.83-6.3L5.47 21H2.4l7.17-8.17L2 3h6.33l4.37 5.75L17.75 3Zm-1.08 16.17h1.7L7.4 4.73H5.58l11.09 14.44Z",
  linkedin:
    "M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9.75h4V21H3V9.75Zm6.5 0h3.83v1.54h.06c.53-1 1.84-1.85 3.78-1.85 4.04 0 4.83 2.5 4.83 5.9V21h-4v-5.02c0-1.2-.02-2.74-1.76-2.74-1.77 0-2.04 1.3-2.04 2.65V21h-4V9.75h-.7Z",
  github:
    "M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z",
};
const CUP = `<svg class="cup-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/></svg>`;
const creatorLink = (href, label, glyph, text) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="atarikcaliskan on ${label}">${brandIcon(BRAND_PATHS[glyph])}<span>${text}</span></a>`;
const CREATOR = `<div class="help-creator"><span class="help-creator-by">Created by <b>@atarikcaliskan</b></span><span class="help-creator-links">${[
  creatorLink("https://x.com/atarikcaliskan", "X", "x", "X"),
  creatorLink("https://www.linkedin.com/in/atarikcaliskan", "LinkedIn", "linkedin", "LinkedIn"),
  creatorLink("https://github.com/atarikcaliskan", "GitHub", "github", "GitHub"),
].join("")}${SUPPORT_URL ? `<a class="help-support" href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">${CUP}<span>Sponsor</span></a>` : ""}</span></div>`;

// Hosted sign-in (src/hud-auth.js). Everything stays hidden until /api/status says auth_required.
const AUTH_SLAB = `<div id="auth-slab" class="auth-slab" hidden>
    <button id="auth-signin" class="auth-signin" aria-haspopup="dialog" aria-label="Sign in to put Jev on the pitch" title="Sign in · all 22 players switch to Jev">${icon("log-in")}<span>Sign in</span></button>
    <button id="auth-account" class="auth-account" aria-haspopup="dialog" aria-expanded="false" aria-controls="account-sheet" title="Your play credit and sign-out" hidden><span id="auth-avatar" class="auth-avatar" aria-hidden="true"></span><span class="auth-id"><b id="auth-name"></b><span class="auth-credit"><small>Credit</small><strong id="auth-credit">$0.0000</strong></span><span class="credit-bar" aria-hidden="true"><i id="auth-credit-bar"></i></span></span></button>
  </div>`;
const AUTH_OVERLAYS = `<section id="account-sheet" class="account-sheet" role="dialog" aria-label="Your matchday pass" tabindex="-1" hidden>
  <span class="slab-tag">Matchday pass</span>
  <div class="sheet-who"><span id="sheet-avatar" class="auth-avatar large" aria-hidden="true"></span><div><b id="sheet-name"></b><span id="sheet-provider"></span></div></div>
  <div class="sheet-credit"><small>Play credit left</small><strong id="sheet-credit">$0.0000</strong><span class="credit-bar" aria-hidden="true"><i id="sheet-credit-bar"></i></span><span id="sheet-ledger" class="sheet-ledger"></span></div>
  <p id="sheet-note" class="sheet-note" hidden></p>
  <button id="auth-signout" class="sheet-signout">${icon("log-out")}<span>Sign out</span></button>
</section>
<div id="credit-whistle" class="whistle" role="status" hidden><span class="slab-tag" id="whistle-tag"></span><strong id="whistle-title"></strong><span id="whistle-text"></span><span class="whistle-support">This demo runs on the creator's own Jev credit${SUPPORT_URL ? ` — if you enjoyed it, <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">${CUP}sponsor the creator on GitHub</a>` : ""}.</span><button id="whistle-close" class="dialog-x" aria-label="Dismiss">${icon("x")}</button></div>

<dialog id="auth-dialog" aria-labelledby="auth-title" aria-describedby="auth-lede">
  <button id="close-auth" class="dialog-x dialog-close" aria-label="Close sign-in">${icon("x")}</button>
  <span class="slab-tag">Substitution</span>
  <h2 id="auth-title">Sign in to put Jev on the pitch</h2>
  <div class="sub-board" aria-hidden="true"><span class="sub off"><i></i><small>Off</small><b>Local policy</b></span><span class="sub on"><i></i><small>On</small><b>Jev <em>× 22</em></b></span></div>
  <p id="auth-lede"></p>
  <div id="auth-providers" class="auth-providers" role="group" aria-label="Sign-in providers"></div>
  <p id="auth-error" class="auth-error" role="alert" hidden></p>
  <p class="auth-fine">We store your provider ID, display name and avatar. No email, no posting rights.</p>
  <button id="auth-dismiss" class="subtle">Keep watching on the local policy</button>
</dialog>`;

export const MATCH_LENGTHS = [
  { seconds: 60, label: "2 × 1 min" },
  { seconds: 180, label: "2 × 3 min" },
  { seconds: 300, label: "2 × 5 min" },
];

export function matchLengthLabel(seconds) {
  const known = MATCH_LENGTHS.find((m) => m.seconds === seconds);
  if (known) return known.label;
  return seconds % 60 === 0
    ? `2 × ${seconds / 60} min`
    : `2 × ${Math.round(seconds)} s`;
}

// Decision-arrow glyphs for the three modes: every option, the chosen one, none.
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const arrowsGlyph = {
  all: svg(
    `<path d="M12 20V3m-3 3 3-3 3 3M12 20C12 14 7 12 3 8m0 3V8h3M12 20c0-6 5-8 9-12m-3 0h3v3"/><circle cx="12" cy="21" r="1" fill="currentColor" stroke="none"/>`,
  ),
  selected: svg(
    `<path d="M12 20V3m-3 3 3-3 3 3"/><path d="M12 20C12 14 7 12 3 8M12 20c0-6 5-8 9-12" stroke-dasharray="1.5 3.5" opacity=".55"/><circle cx="12" cy="21" r="1" fill="currentColor" stroke="none"/>`,
  ),
  off: svg(
    `<path d="M12 20V3m-3 3 3-3 3 3" opacity=".45"/><path d="M4 4l16 16"/><circle cx="12" cy="21" r="1" fill="currentColor" stroke="none"/>`,
  ),
};

export const ARROW_MODES = ["all", "selected", "off"];
export const ARROW_MODE_LABEL = {
  all: "All options",
  selected: "Chosen only",
  off: "Off",
};

export function hudMarkup(teams, halfSeconds) {
  const [home, away] = teams;
  const name = (t) => escapeHtml(t.name),
    short = (t) => escapeHtml(t.short),
    shirt = (t) => escapeHtml(t.colors.shirt);
  const lengths = [...MATCH_LENGTHS];
  if (!lengths.some((m) => m.seconds === halfSeconds))
    lengths.push({ seconds: halfSeconds, label: matchLengthLabel(halfSeconds) });
  const bugTeam = (t, side) =>
    `<span class="bug-team ${side}" style="--team:${shirt(t)}" title="${name(t)}"><b>${short(t)}</b></span>`;
  const key = (keys, text) => `<span><kbd>${keys}</kbd>${text}</span>`;
  return `
<main class="match-area" aria-label="3D football match"><canvas id="world-canvas" aria-label="Three-dimensional stadium view"></canvas><div id="vector-labels" aria-label="Jev option probabilities"></div></main>

<div class="score-hud">
  <section class="bug" aria-label="Scoreboard">
    <div class="bug-row">
      ${bugTeam(home, "home")}
      <strong class="bug-score" aria-live="polite"><span id="score-home">0</span><em>–</em><span id="score-away">0</span></strong>
      ${bugTeam(away, "away")}
      <span class="bug-clock"><b id="clock-minute">0'</b><small id="clock-half">1ST HALF</small></span>
    </div>
    <div class="possession" title="Possession"><span id="poss-home-label">50</span><div class="possession-bar"><i id="poss-home" style="background:${shirt(home)}"></i><i id="poss-away" style="background:${shirt(away)}"></i></div><span id="poss-away-label">50</span></div>
  </section>
  <div id="phase-badge" class="phase-badge" role="status" hidden></div>
</div>

<header class="topbar" aria-label="JevBall match controls">
  <a href="/" class="brand" title="Back to the JevBall home page" aria-label="JevBall — back to the home page"><img class="brand-mark" src="/brand/jevball-mark.svg" alt=""/><b>JevBall</b></a>
  <label class="length-slab" title="Match length"><span>Match</span><select id="match-length" aria-label="Match length">${lengths.map((m) => `<option value="${m.seconds}"${m.seconds === halfSeconds ? " selected" : ""}>${m.label}</option>`).join("")}</select></label>
  <button id="new-match" title="New match" aria-label="New match">${icon("rotate-cw")}</button>
  <button id="help" title="Controls and how it works · ?" aria-label="Controls and how it works">${icon("circle-help")}</button>
  <a id="source-link" href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer" title="Source code on GitHub" aria-label="JevBall source code on GitHub (opens in a new tab)">${brandIcon(BRAND_PATHS.github)}</a>
</header>

<aside class="side-hud" aria-label="Match insight">
  <section id="radar" class="board panel">
    <div class="card-toolbar"><span class="card-title">Tactics board</span><span id="radar-hint" class="card-hint">Click a player</span><button id="radar-toggle" aria-label="Hide tactics board" aria-expanded="true" title="Hide tactics board">${icon("chevron-down")}</button></div>
    <canvas id="radar-canvas" aria-label="Top-down tactics board. Click a player to inspect their decision."></canvas>
  </section>
  <section id="feed" class="feed panel">
    <div class="card-toolbar"><span class="card-title"><i class="live-dot" aria-hidden="true"></i>Jev feed</span><span id="feed-rate" class="card-hint"></span><button id="feed-toggle" aria-label="Hide Jev feed" aria-expanded="true" title="Hide Jev feed">${icon("chevron-down")}</button></div>
    <ol id="feed-list" class="feed-list" aria-label="Latest decisions and match events"></ol>
  </section>
</aside>

<section id="player-card" class="player-card" aria-label="Focused player" aria-live="off" hidden>
  <div class="pc-head">
    <span id="pc-number" class="pc-number"></span>
    <div class="pc-id"><b id="pc-name"></b><span id="pc-team"></span></div>
    <button id="pc-close" aria-label="Clear focus" title="Clear focus · Esc">${icon("x")}</button>
  </div>
  <div class="pc-meta"><span id="pc-kind"></span><span id="pc-source" class="source-badge"></span><span id="pc-confidence"></span></div>
  <div id="pc-options" class="pc-options"></div>
  <div class="pc-legend"><span><i class="legend-bar"></i>chosen</span><span><i class="legend-dot"></i>local policy's pick</span></div>
</section>

<div id="halftime" class="interlude" hidden><span class="slab-tag">Half-time</span><strong id="halftime-score"></strong><span id="halftime-note">Teams are switching ends</span></div>
<div id="paused-overlay" hidden><div class="paused-card"><span class="slab-tag">${icon("pause")}Paused</span><button id="resume" class="primary">Resume match</button></div></div>

<div class="bottom-hud"><div class="match-dock">
  <div class="dock-play">
    <button id="play-toggle" class="cta" role="switch" aria-checked="false" aria-label="Take control of a player" title="Take control · J">${icon("gamepad-2")}<i class="cta-live" aria-hidden="true"></i><span id="play-label">PLAY AS #9</span><kbd>J</kbd></button>
    <button id="candidates-toggle" class="arrows-button" data-mode="all" aria-label="Decision arrows: all options" title="Decision arrows · K"><span class="arrows-glyph" data-for="all">${arrowsGlyph.all}</span><span class="arrows-glyph" data-for="selected">${arrowsGlyph.selected}</span><span class="arrows-glyph" data-for="off">${arrowsGlyph.off}</span><span class="tool-text"><small>Arrows</small><b id="candidates-name">All options</b></span></button>
  </div>
  <div id="decision-status"><span id="pilot-state">Jev · 22 players</span><span id="context-message">Connecting…</span><span class="cost-total" title="Estimated cost from Jev-reported token usage and configured pricing."><span id="cost-label">Session</span> <strong id="cost">$0.000000</strong></span>${AUTH_SLAB}</div>
  <div class="dock-tools" role="group" aria-label="View and match controls">
    <button id="camera" title="Change camera · C" aria-label="Change camera">${icon("video")}<span class="tool-text"><small>Camera</small><b id="camera-name">Broadcast</b></span></button>
    <button id="speed" title="Match speed" aria-label="Match speed">${icon("gauge")}<span class="tool-text"><small>Speed</small><b id="speed-name">1×</b></span></button>
    <button id="scene-json" class="icon-only" aria-label="Inspect live JSON" title="Under the hood · live JSON">${icon("braces")}</button>
    <button id="fullscreen" class="icon-only" aria-label="Enter fullscreen" title="Fullscreen">${icon("maximize")}</button>
    <button id="pause" class="icon-only pause-button" aria-label="Pause match" title="Pause · P">${icon("pause")}</button>
  </div>
</div></div>

<div id="touch-controls" class="touch-controls" role="group" aria-label="Touch player controls" hidden><div class="touch-steering"><div class="touch-stick" role="group" aria-label="Movement thumbstick: drag to run, push to the edge to sprint"><span class="touch-knob" aria-hidden="true"></span></div><span class="touch-hint">Drag to run · edge to sprint</span></div><div class="touch-buttons"><button class="touch-button small" data-touch="switch" aria-label="Switch player">Switch</button><button class="touch-button" data-touch="pass" aria-label="Pass">Pass</button><button class="touch-button shoot" data-touch="shoot" aria-label="Shoot">Shoot</button></div></div>
<div id="toast" role="status" hidden></div>
${AUTH_OVERLAYS}

<dialog id="json-dialog" aria-label="Under the hood">
  <div class="json-header"><div><span class="slab-tag">${icon("braces")}Under the hood</span><span id="json-live">LIVE · 4 Hz</span></div><button id="close-json" class="dialog-x" aria-label="Close JSON inspector">${icon("x")}</button></div>
  <div class="json-toolbar"><div class="json-tabs" role="tablist"><button data-tab="request" class="active">Jev input</button><button data-tab="response">Response</button><button data-tab="decisions">Decisions</button><button data-tab="match">Match state</button><button data-tab="session">Session</button></div><div class="json-actions"><button id="freeze-json">Freeze</button><button id="copy-json" aria-label="Copy displayed JSON">${icon("copy")} <span id="copy-json-label" aria-live="polite">Copy</span></button><button id="download-json">${icon("download")} Download</button></div></div>
  <p id="json-description"></p>
  <pre id="json-content" tabindex="0"></pre>
</dialog>

<dialog id="help-dialog" aria-labelledby="help-title">
  <button id="close-help" class="dialog-x dialog-close" aria-label="Close help">${icon("x")}</button>
  <span class="slab-tag">22 models · one match</span>
  <h2 id="help-title">Watch, inspect, or play.</h2>
  <p class="touch-help">Tap <b>Play</b> to take over a player: drag the thumbstick to run (push to the edge to sprint), then use Pass, Shoot and Switch.</p>
  <div class="help-keys">${[
    key("J", "Play / watch"),
    key("W A S D", "Move (camera-relative)"),
    key("SHIFT", "Sprint"),
    key("SPACE", "Pass"),
    key("F / ENTER", "Shoot"),
    key("Q", "Switch player"),
    key("K", "Arrows: all · chosen · off"),
    key("C", "Camera"),
    key(", / .", "Slower / faster"),
    key("P", "Pause"),
    key("ESC", "Clear focus"),
    key("?", "This sheet"),
  ].join("")}</div>
  <h3>How it works</h3>
  <p>Every player is an independent Jev decision-maker. A few times per second the simulation works out each player's realistic options locally — passes, shots, dribbles, runs, marking — with features such as distance, lane clearance and expected goals. Jev only picks among those typed candidates and returns a probability for each. All players whose decision is due share one request: the match state is sent once, with one question per player.</p>
  <p>Physics, rules, reflexes (first touch, keeper saves, meeting a pass) and candidate geometry stay local. Without an API key, or while Jev is rate-limited, players fall back to the built-in local policy so play never stalls.</p>
  <p>The chalk arrows on the pitch are the focused player's options: <span class="swatch chalk"></span>white for ordinary options, <span class="swatch risk"></span>orange for risky ones, <span class="swatch shot"></span>red for shots and <span class="swatch flood"></span>floodlight yellow for the one that was chosen. <b>Arrows</b> in the control strip cycles all options → chosen only → off. Click a player on the tactics board to focus them and compare Jev's probabilities with the local policy's pick. <b>Under the hood</b> shows the exact Jev payload, the response, every player's latest decision, the match state and session telemetry.</p>
  <p class="asset-credits">Grass, pavement and sky: <a href="https://polyhaven.com" target="_blank" rel="noreferrer">Poly Haven</a>, CC0. Inspired by <a href="https://github.com/standardagents/jevpilot" target="_blank" rel="noreferrer">JevPilot</a> by Standard Agents. Jev is <a href="https://typesafe.ai/" target="_blank" rel="noreferrer">TypeSafe AI</a>'s System One model. <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Source code</a> on GitHub, free for noncommercial use.</p>
  ${CREATOR}
</dialog>

<dialog id="fulltime-dialog" aria-labelledby="fulltime-title">
  <div class="ft-head"><span class="slab-tag">Full-time</span><span class="ft-comp">JevBall · 22 models, one match</span></div>
  <div class="ft-score"><span class="ft-team home" style="--team:${shirt(home)}">${name(home)}</span><strong id="fulltime-score"></strong><span class="ft-team away" style="--team:${shirt(away)}">${name(away)}</span></div>
  <h1 id="fulltime-title"></h1>
  <table class="stats-table"><tbody id="fulltime-stats"></tbody></table>
  <p id="fulltime-session"></p>
  <div class="ft-actions"><button id="play-again" class="primary">Play again ${icon("arrow-up-right")}</button><button id="fulltime-inspect" class="subtle">Keep the stadium open</button></div>
</dialog>`;
}
