import "./theme.css";
import "./style.css";
import {
  hudMarkup,
  icon,
  refreshIcons,
  matchLengthLabel,
  ARROW_MODES,
  ARROW_MODE_LABEL,
} from "./hud-markup.js";
import { Scoreboard } from "./hud-scoreboard.js";
import { Radar } from "./hud-radar.js";
import { Feed } from "./hud-feed.js";
import { PlayerCard } from "./hud-player-card.js";
import { Inspector } from "./hud-inspector.js";
import { AuthHud } from "./hud-auth.js";
import { average, escapeHtml, money, statsRows } from "./hud-format.js";
import { HumanInput, isMoveKey } from "./input.js";
import { TouchControls } from "./touch-controls.js";
import { Tooltips } from "./tooltips.js";
import {
  showLoading,
  hideLoading,
  loadingFailed,
  nextPaint,
} from "./loading-screen.js";

// hud-test.html injects mock modules here so the HUD can be checked on its own.
const modules = globalThis.__JEVBALL_MODULES__ ?? (await loadModules());
async function loadModules() {
  const [simulation, stadium, decisions, pitch] = await Promise.all([
    import("./simulation.js"),
    import("./scene.js"),
    import("./decision-loop.js"),
    import("./pitch.js"),
  ]);
  return {
    Simulation: simulation.Simulation,
    MatchScene: stadium.MatchScene,
    DecisionLoop: decisions.DecisionLoop,
    TEAMS: pitch.TEAMS,
    PITCH: pitch.PITCH,
  };
}
const { Simulation, MatchScene, DecisionLoop, TEAMS, PITCH } = modules;

const $ = (id) => document.getElementById(id);
const STEP = 1 / 60,
  // 1× is deliberately 0.75 sim-seconds per real second: 22 simultaneous
  // decision-makers read best slightly slower than real time.
  BASE_RATE = 0.75,
  SPEEDS = [0.5, 0.75, 1, 1.5, 2, 3],
  DEFAULT_SPEED = 1,
  ARROWS_KEY = "jevball.arrows";
const params = new URLSearchParams(location.search),
  forceLocal = ["1", "true"].includes(params.get("local")),
  randomSeed = () => Math.floor(Math.random() * 999999);
let halfSeconds = Math.min(Math.max(Number(params.get("half")) || 180, 10), 2700);

function nearestSpeed(value) {
  if (!(Number(value) > 0)) return DEFAULT_SPEED;
  return SPEEDS.reduce((best, s) =>
    Math.abs(s - value) < Math.abs(best - value) ? s : best,
  );
}
function storedArrows() {
  const fromUrl = params.get("arrows")?.toLowerCase();
  if (ARROW_MODES.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(ARROWS_KEY);
    if (ARROW_MODES.includes(saved)) return saved;
  } catch {
    // Storage can be blocked; the default still works.
  }
  return "all";
}

let sim, scene, loop;
let loading = true,
  speed = params.has("speed") ? nearestSpeed(params.get("speed")) : DEFAULT_SPEED,
  accumulator = 0,
  lastNow = performance.now(),
  focusId = null,
  arrowsMode = storedArrows(),
  pricing = null,
  serverConfigured = false,
  statusKnown = false,
  // Hosted mode (docs/AUTH.md): the last /api/status body when it says
  // auth_required, and why Jev is off: "auth" | "credit" | "cap" | null.
  hosted = null,
  hold = null,
  capAt = 0,
  lastStatusAt = -Infinity,
  signingOut = false,
  seenHeld = null,
  nextStatusCheck = 0,
  fulltimeAt = 0,
  fulltimeShown = false,
  lastScore = [0, 0],
  toastTimer;
const due = { board: 0, radar: 0, feed: 0, card: 0, dock: 0, inspector: 0 };
const rate = { at: 0, decisions: 0, perSecond: 0 };
const toastSeen = new Map();

showLoading("Building the stadium…");
$("app").innerHTML = hudMarkup(TEAMS, halfSeconds);
refreshIcons();

const input = new HumanInput(),
  tooltips = new Tooltips(),
  scoreboard = new Scoreboard(),
  radar = new Radar($("radar-canvas"), {
    teams: TEAMS,
    pitch: PITCH,
    onPick: (id) => setFocus(id),
  }),
  feed = new Feed($("feed-list"), { teams: TEAMS, onPick: (id) => setFocus(id) }),
  playerCard = new PlayerCard({ teams: TEAMS }),
  inspector = new Inspector(
    () => ({ sim, loop, mode: mode(), pricing, seed: sim.seed }),
    { onOpen: () => touch.reset() },
  ),
  auth = new AuthHud({
    toast: (text, type) => toast(text, type),
    onOpen: () => {
      input.clear();
      touch.reset();
    },
    onSigningOut: () => (signingOut = true),
    onSignOutFailed: () => (signingOut = false),
    onSignedOut: async () => {
      // Flip at once so nothing is asked of Jev while the status reloads.
      if (hosted) applyHosted({ ...hosted, authenticated: false, user: null, credits: null });
      await checkStatus();
      signingOut = false;
      toast("Signed out — the match plays on with the local policy.", "info", 0);
    },
  }),
  touch = new TouchControls(
    $("touch-controls"),
    () =>
      !loading &&
      !!sim?.human &&
      !sim.paused &&
      !document.hidden &&
      sim.phase !== "fulltime" &&
      !document.querySelector("dialog[open]"),
    { onSwitch: () => switchPlayer() },
  );
const dockObserver = new ResizeObserver(([entry]) => {
  // Anchor the thumbs and the toast above the real dock, wrapped or not.
  const height =
    entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
  document.documentElement.style.setProperty("--dock-height", `${height}px`);
});
dockObserver.observe(document.querySelector(".match-dock"));
tooltips.adopt($("app").querySelector(".topbar"));
tooltips.adopt($("app").querySelector(".bottom-hud"));
tooltips.adopt($("app").querySelector(".score-hud"));
tooltips.adopt($("player-card"));
for (const toolbar of document.querySelectorAll(".side-hud .card-toolbar"))
  tooltips.adopt(toolbar);

// ---------------------------------------------------------------- match setup
function buildMatch(seed) {
  sim = new Simulation(seed, { halfSeconds });
  scene = new MatchScene($("world-canvas"), sim, $("vector-labels"));
  const previous = loop;
  loop = new DecisionLoop(sim, { endpoint: "/api/decide" });
  // The cost tally is a session figure: it survives new matches.
  if (previous) {
    previous.enabled = false;
    loop.tally = previous.tally;
  }
  wireLoop();
  applyArrows();
  applySpeed();
  const wanted = params.get("cam");
  const camera =
    wanted &&
    scene.cameraNames?.find(
      (name) =>
        name.toLowerCase().replace(/[^a-z]/g, "") ===
        wanted.toLowerCase().replace(/[^a-z]/g, ""),
    );
  if (camera) scene.setCamera(camera);
  showCamera(camera || scene.cameraName || scene.cameraNames?.[0]);
  focusId = null;
  accumulator = 0;
  fulltimeAt = 0;
  fulltimeShown = false;
  lastScore = [...sim.score];
  rate.at = 0;
  rate.decisions = loop.tally.decisions;
  scoreboard.reset();
  feed.reset();
  playerCard.reset();
  for (const key in due) due[key] = 0;
}

async function finishLoading() {
  await scene.ready;
  showLoading("Warming up the players…");
  await document.fonts?.ready;
  await nextPaint();
  scene.resize?.();
  lastNow = performance.now();
  loading = false;
  hideLoading();
  syncPlay();
  // The landing page's "Take the pitch" arrives with ?play=1; only the first match honours it.
  if (params.get("play") === "1" && !startedFromLink) {
    startedFromLink = true;
    setPlaying(true);
  }
  refreshHud(performance.now(), true);
}

async function newMatch(nextHalfSeconds = halfSeconds) {
  if (loading) return;
  loading = true;
  showLoading("Setting up the next match…");
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  input.clear();
  touch.reset();
  $("paused-overlay").hidden = true;
  await nextPaint();
  try {
    halfSeconds = nextHalfSeconds;
    scene.dispose();
    // The scene keeps one WebGL renderer per canvas and reuses it, so the
    // next MatchScene gets the same canvas (a new one would leak a context).
    $("vector-labels").replaceChildren();
    buildMatch(randomSeed());
    syncPause();
    await finishLoading();
  } catch (error) {
    loadingFailed(error);
  }
}

// ------------------------------------------------------------------- helpers
function mode() {
  return loop.configured && loop.enabled && !forceLocal && !loop.held ? "jev" : "local";
}

// ------------------------------------------------------- hosted sign-in, credit
const CAP_RETRY_MS = 10 * 60 * 1000;

function wireLoop() {
  syncLoop();
  loop.onError = (message) => {
    // Sign-in, credit and daily-cap refusals have their own message.
    if (hosted && (loop.held || hold)) return;
    toast(explainError(message), "error");
  };
  loop.onCredits = (credits) => {
    if (hosted?.authenticated) auth.setCredits(credits);
  };
  loop.onAuthRequired = () => sessionExpired();
  loop.onCreditExhausted = (credits) => creditExhausted(credits);
}

// Jev is asked only when the server has a key and, on the hosted site, the
// visitor is signed in with credit. `configured = false` guarantees that no
// /api/decide request leaves the browser while signed out.
function syncLoop() {
  const on = serverConfigured && !forceLocal && !(hosted && hold);
  loop.configured = on;
  if (on && loop.held) {
    if (typeof loop.resume === "function") loop.resume();
    else loop.held = null;
  }
  seenHeld = loop.held ?? null;
  auth.setHold(hosted?.authenticated ? (hold ?? (serverConfigured ? null : "offline")) : null);
}

function applyHosted(data) {
  const was = hosted;
  hosted = {
    ...data,
    authenticated: !!data.authenticated && !!data.user,
    providers: Array.isArray(data.providers) ? data.providers : [],
  };
  if (!hosted.authenticated) {
    hosted.user = hosted.credits = null;
    hold = "auth";
  } else if (hosted.credits?.exhausted) {
    // Live transition only: a page that loads already exhausted just says so.
    if (was?.authenticated && hold !== "credit") creditExhausted(hosted.credits);
    hold = "credit";
  } else if (hold === "cap" && performance.now() - capAt < CAP_RETRY_MS) hold = "cap";
  else hold = null;
  auth.render(hosted, hold);
  syncLoop();
}

function sessionExpired() {
  if (!hosted?.authenticated || signingOut) return;
  applyHosted({ ...hosted, authenticated: false, user: null, credits: null });
  toast("Your session expired — sign in again to bring Jev back. The local policy has taken over.", "error", Infinity);
  checkStatus();
}

function creditExhausted(credits) {
  if (!hosted?.authenticated) return;
  hold = "credit";
  auth.setCredits({ ...(credits ?? hosted.credits ?? {}), exhausted: true });
  syncLoop();
  auth.creditWhistle();
}

function dailyCap() {
  if (!hosted?.authenticated || hold === "cap") return;
  hold = "cap";
  capAt = performance.now();
  syncLoop();
  toast("Jev's shared budget for today is spent — the local policy plays on. Your credit is untouched.", "info", Infinity);
}

// The loop reports a daily cap only through `held`; the other holds are
// caught here too in case a callback was missed.
function watchLoop() {
  const held = loop.held ?? null;
  if (held === seenHeld) return;
  seenHeld = held;
  if (held === "cap") dailyCap();
  else if (held === "credit") creditExhausted(loop.credits);
  else if (held === "auth") sessionExpired();
}

// Back from the provider: /play.html?auth=ok | ?auth=error.
const authReturn = params.get("auth");
if (authReturn) {
  const url = new URL(location.href);
  url.searchParams.delete("auth");
  history.replaceState(history.state, "", url);
}
const SIGN_IN_FAILED = "Sign-in could not be completed. Please try again.";

function recheckOnFocus() {
  if (document.hidden || !hosted || performance.now() - lastStatusAt < 30000) return;
  checkStatus();
}
window.addEventListener("focus", recheckOnFocus);
document.addEventListener("visibilitychange", recheckOnFocus);

function toast(text, type = "info", repeatAfterMs = 9000) {
  const now = performance.now();
  if (now - (toastSeen.get(text) ?? -Infinity) < repeatAfterMs) return;
  toastSeen.set(text, now);
  $("toast").textContent = text;
  $("toast").classList.toggle("error", type === "error");
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4600);
}

function explainError(message = "") {
  if (/rate limit|too many|429/i.test(message))
    return "Jev rate limit reached — players are using the local policy for a moment";
  if (/TYPESAFE_API_KEY|api key/i.test(message))
    return `${message} Players are using the local policy.`;
  return `${message} Players are using the local policy for a moment.`;
}

async function checkStatus() {
  nextStatusCheck = performance.now() + 20000;
  lastStatusAt = performance.now();
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const data = await response.json();
    const first = !statusKnown;
    statusKnown = true;
    pricing = data.pricing ?? pricing;
    if (data.auth_required) {
      serverConfigured = !!data.configured;
      applyHosted(data);
      updateCostTooltip();
      if (!first) return;
      if (authReturn === "error" || (authReturn === "ok" && !hosted.authenticated))
        toast(SIGN_IN_FAILED, "error");
      else if (authReturn === "ok")
        toast(
          hold === "credit"
            ? "Signed in — your free credit is used up, so the local policy keeps playing."
            : "Signed in — Jev is on the pitch for all 22 players.",
        );
      else if (forceLocal) toast("Local policy forced with ?local=1 — no Jev requests are made");
      else if (!hosted.authenticated)
        toast("Free to watch on the local policy — sign in to put Jev on the pitch.");
      return;
    }
    if (hosted) {
      hosted = hold = null;
      auth.render(null);
    }
    // After a rejected key the loop switches itself off; do not flip it back
    // on just because the server still has a (bad) key configured.
    if (first || !serverConfigured) loop.configured = !!data.configured && !forceLocal;
    serverConfigured = !!data.configured;
    updateCostTooltip();
    if (first && forceLocal)
      toast("Local policy forced with ?local=1 — no Jev requests are made");
    else if (first && !serverConfigured)
      toast("No TYPESAFE_API_KEY — running on the local policy");
  } catch {
    if (!statusKnown) {
      statusKnown = true;
      toast("Jev server unavailable — running on the local policy", "error");
      if (authReturn === "error") toast(SIGN_IN_FAILED, "error");
    }
  }
}

function updateCostTooltip() {
  const t = loop.tally;
  const averages = t.calls
    ? `${t.calls.toLocaleString()} calls · ${Math.round(t.input / t.calls).toLocaleString()} input tokens/call · ${(t.request_bytes / t.calls / 1024).toFixed(1)} KB/call. `
    : "";
  tooltips.set(
    document.querySelector(".cost-total"),
    pricing
      ? `${averages}Estimated from Jev-reported tokens at $${pricing.input_per_million}/M input and $${pricing.output_per_million}/M output. Local-policy decisions are free.`
      : `${averages}Estimated from Jev-reported token usage. Local-policy decisions are free.`,
  );
}

function setFocus(id) {
  focusId = id && sim.player(id) ? id : null;
  scene.setFocus(focusId);
  $("radar-hint").textContent = focusId ? `Focus · ${focusId}` : "Click a player";
  due.card = due.radar = 0;
  syncPlay();
}

function showCamera(name) {
  if (!name) return;
  $("camera-name").textContent = name;
  tooltips.set($("camera"), `Change camera · ${name} · C`);
}

function changeCamera() {
  showCamera(scene.nextCamera());
}

function applySpeed() {
  const label = `${speed}×`;
  $("speed-name").textContent = label;
  $("speed").classList.toggle("active", speed !== DEFAULT_SPEED);
  $("speed").setAttribute("aria-label", `Match speed ${label}. Click for faster, Shift+click for slower.`);
  tooltips.set(
    $("speed"),
    `Match speed · ${label}${speed === DEFAULT_SPEED ? " (default)" : ""} · click faster, Shift+click slower · , .`,
  );
  // Decisions are due in sim time, so the request scheduler keeps pace with a
  // faster match instead of letting players time out onto the local policy.
  if (loop) loop.tickMs = Math.round(250 / Math.max(1, speed * BASE_RATE));
  // Start a fresh window so the decisions/s readout is not a blend of speeds.
  rate.at = 0;
}

// direction +1: next step up, wrapping to the slowest; -1: one step down,
// wrapping to the fastest.
function changeSpeed(direction = 1) {
  const at = SPEEDS.indexOf(speed);
  speed = SPEEDS[(at + direction + SPEEDS.length) % SPEEDS.length];
  applySpeed();
}

function applyArrows() {
  // Newer scenes take the three-state mode; older ones only know on/off.
  if (typeof scene.setCandidatesMode === "function")
    scene.setCandidatesMode(arrowsMode);
  else scene.setCandidatesVisible?.(arrowsMode === "all");
  const button = $("candidates-toggle");
  const next = ARROW_MODES[(ARROW_MODES.indexOf(arrowsMode) + 1) % ARROW_MODES.length];
  button.dataset.mode = arrowsMode;
  $("candidates-name").textContent = ARROW_MODE_LABEL[arrowsMode];
  button.setAttribute(
    "aria-label",
    `Decision arrows: ${ARROW_MODE_LABEL[arrowsMode].toLowerCase()}. Click for ${ARROW_MODE_LABEL[next].toLowerCase()}.`,
  );
  tooltips.set(
    button,
    `Decision arrows · ${ARROW_MODE_LABEL[arrowsMode]} → ${ARROW_MODE_LABEL[next]} · K`,
  );
}

function cycleArrows() {
  arrowsMode = ARROW_MODES[(ARROW_MODES.indexOf(arrowsMode) + 1) % ARROW_MODES.length];
  try {
    localStorage.setItem(ARROWS_KEY, arrowsMode);
  } catch {
    // Not persisted; the mode still applies for this visit.
  }
  applyArrows();
}

function syncPause() {
  $("paused-overlay").hidden = !sim.paused;
  $("pause").innerHTML = icon(sim.paused ? "play" : "pause");
  $("pause").setAttribute("aria-label", sim.paused ? "Resume match" : "Pause match");
  tooltips.set($("pause"), `${sim.paused ? "Resume" : "Pause"} · P`);
  refreshIcons();
  touch.sync();
}

function togglePause() {
  if (loading || sim.phase === "fulltime") return;
  input.clear();
  touch.reset();
  sim.paused = !sim.paused;
  syncPause();
}

// ---------------------------------------------------------- human control
function humanCandidate() {
  const focused = focusId && sim.player(focusId);
  if (focused && focused.team === 0 && focused.role !== "GK") return focused;
  const outfield = sim.teamPlayers(0).filter((p) => p.role !== "GK");
  return (
    outfield.find((p) => p.role === "ST") ??
    outfield.reduce(
      (best, p) =>
        !best ||
        Math.hypot(p.x - sim.ball.x, p.y - sim.ball.y) <
          Math.hypot(best.x - sim.ball.x, best.y - sim.ball.y)
          ? p
          : best,
      null,
    )
  );
}

function syncPlay() {
  const playing = !!sim.human;
  const button = $("play-toggle");
  const label = playing
    ? `LIVE · YOU ARE ${sim.human.playerId}`
    : `PLAY AS #${humanCandidate()?.number ?? 9}`;
  if ($("play-label").textContent !== label) $("play-label").textContent = label;
  if (button.getAttribute("aria-checked") !== String(playing)) {
    button.setAttribute("aria-checked", String(playing));
    tooltips.set(
      button,
      playing ? "Hand the player back to Jev · J" : "Take control of this player · J",
    );
    document.body.classList.toggle("playing", playing);
  }
  button.disabled = sim.phase === "fulltime";
  touch.sync();
}

let startedFromLink = false;
function setPlaying(on) {
  if (loading || sim.phase === "fulltime") return;
  input.clear();
  touch.reset();
  if (on) {
    const player = humanCandidate();
    if (!player) return;
    sim.setHuman(player.id);
    toast(
      touch.available
        ? `You are ${player.id}. Drag to run, then Pass or Shoot.`
        : `You are ${player.id} · WASD to move · Space pass · F shoot · Q switch`,
      "info",
      0,
    );
  } else sim.setHuman(null);
  due.dock = due.card = 0;
  syncPlay();
}

function switchPlayer() {
  if (!sim.human) return;
  sim.switchHuman();
  due.dock = due.card = 0;
  syncPlay();
}

// ------------------------------------------------------------------ full-time
function showFulltime() {
  fulltimeShown = true;
  if (sim.human) sim.setHuman(null);
  syncPlay();
  const [home, away] = sim.score;
  $("fulltime-title").textContent =
    home === away
      ? "Honours even."
      : `${TEAMS[home > away ? 0 : 1].name} win.`;
  $("fulltime-score").innerHTML = `<span>${home}</span><em>–</em><span>${away}</span>`;
  $("fulltime-stats").innerHTML = statsRows(sim.stats)
    .map((row) => {
      const total = row.share[0] + row.share[1];
      const left = total ? (row.share[0] / total) * 100 : 50;
      return `<tr><td>${escapeHtml(row.home)}</td><th scope="row"><span>${row.label}</span><span class="stat-bar"><i style="width:${left}%;background:${TEAMS[0].colors.shirt}"></i><i style="width:${100 - left}%;background:${TEAMS[1].colors.shirt}"></i></span></th><td>${escapeHtml(row.away)}</td></tr>`;
    })
    .join("");
  const t = loop.tally;
  $("fulltime-session").textContent = t.calls
    ? `Session so far: ${money(t.cost)} · ${t.calls.toLocaleString()} Jev calls · ${t.jevDecisions.toLocaleString()} Jev decisions · ${t.localDecisions.toLocaleString()} local`
    : `Played on the local policy · ${t.decisions.toLocaleString()} decisions · ${money(0)}`;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("fulltime-dialog").showModal();
}

// ------------------------------------------------------------------ HUD refresh
// The phone strip has room for about 18 characters.
const narrow = matchMedia("(max-width: 700px)");
const HOSTED_STATE_SHORT = {
  auth: "Local · sign in for Jev",
  credit: "Local · credit used up",
  cap: "Local · Jev rests today",
  offline: "Local · Jev unavailable",
};
const HOSTED_STATE = {
  auth: "Local policy · sign in for Jev",
  credit: "Local policy · free credit used up",
  cap: "Local policy · Jev rests until tomorrow",
  offline: "Local policy · Jev unavailable",
};

function refreshDock(now) {
  watchLoop();
  const t = loop.tally;
  if (!rate.at) {
    rate.at = now;
    rate.decisions = t.decisions;
  } else if (now - rate.at >= 1500) {
    const perSecond = ((t.decisions - rate.decisions) * 1000) / (now - rate.at);
    rate.perSecond = rate.perSecond ? rate.perSecond * 0.4 + perSecond * 0.6 : perSecond;
    rate.at = now;
    rate.decisions = t.decisions;
  }
  const current = mode();
  const playing = !!sim.human;
  const state = playing
    ? `You + 21 ${current === "jev" ? "Jev" : "local"}`
    : current === "jev"
      ? loop.backingOff
        ? "Jev · backing off"
        : "Jev · 22 players"
      : forceLocal
        ? "Local policy · forced"
        : hosted
          ? (narrow.matches ? HOSTED_STATE_SHORT : HOSTED_STATE)[
              hosted.authenticated ? (hold ?? "offline") : "auth"
            ]
          : statusKnown && !serverConfigured
            ? "Local policy · no API key"
            : "Local policy";
  let context;
  if (sim.phase === "fulltime") context = "Full-time · start a new match";
  else if (playing)
    context = touch.available
      ? "Drag to run · Pass · Shoot"
      : "WASD move · Space pass · F shoot · Q switch";
  else {
    const perSecond = `${Math.round(rate.perSecond)} decisions/s`;
    context =
      current === "jev" && t.latencies.length
        ? `${perSecond} · ${Math.round(average(t.latencies.slice(-40)))} ms avg`
        : current === "jev"
          ? `${perSecond} · waiting for Jev`
          : `${perSecond} · computed locally`;
  }
  if ($("pilot-state").textContent !== state) $("pilot-state").textContent = state;
  if ($("context-message").textContent !== context)
    $("context-message").textContent = context;
  const cost = money(t.cost);
  if ($("cost").textContent !== cost) {
    $("cost").textContent = cost;
    updateCostTooltip();
  }
  document.body.classList.toggle("jev-live", current === "jev");
  const feedRate = current === "jev" ? "live from Jev" : "local policy";
  if ($("feed-rate").textContent !== feedRate) $("feed-rate").textContent = feedRate;
  syncPlay();
}

function refreshHud(now, force = false) {
  const ready = (key, every) => {
    if (!force && now < due[key]) return false;
    due[key] = now + every;
    return true;
  };
  if (ready("board", 100)) scoreboard.update(sim);
  if (ready("radar", 50) && !$("radar").classList.contains("collapsed"))
    radar.draw(sim, focusId, now);
  if (ready("feed", 100)) feed.update(sim, loop, now);
  if (ready("card", 120)) playerCard.update(sim, focusId);
  if (ready("dock", 250)) refreshDock(now);
  if (inspector.isOpen && ready("inspector", 250)) inspector.render();
}

// --------------------------------------------------------------------- frame
function blockingDialogOpen() {
  // The inspector is for watching live data, so it must not stop the match.
  return !!document.querySelector("dialog[open]:not(#json-dialog)");
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastNow) / 1000, 0.25);
  lastNow = now;
  if (loading || document.hidden) return;
  touch.sync();
  const running = !sim.paused && !blockingDialogOpen();
  if (running) {
    input.apply(sim, scene.cameraBasis?.(), touch);
    accumulator += dt * speed * BASE_RATE;
    // Catch-up budget scales with speed: 3× needs three steps per 60 Hz frame
    // and should survive a slow frame, but never replay more than ~0.1 s of
    // wall time, so a stall cannot snowball.
    const maxSteps = Math.ceil(6 * Math.max(1, speed * BASE_RATE));
    let steps = 0;
    while (accumulator >= STEP && steps < maxSteps) {
      sim.step(STEP);
      accumulator -= STEP;
      steps++;
    }
    // A long stall is dropped rather than replayed (no spiral of death).
    if (accumulator >= STEP) accumulator = 0;
    loop.tick(now);
  }
  if (sim.score[0] !== lastScore[0] || sim.score[1] !== lastScore[1]) {
    const team = sim.score[0] !== lastScore[0] ? 0 : 1;
    lastScore = [...sim.score];
    scene.celebrate?.(team);
  }
  if (sim.phase === "fulltime" && !fulltimeShown) {
    fulltimeAt ||= now;
    if (now - fulltimeAt > 1400) showFulltime();
  }
  // Re-check now and then while on the local policy, so adding a key and
  // restarting the server is picked up without a reload.
  // The hosted site re-checks on focus, sign-in/out and loop reports instead.
  if (now > nextStatusCheck && (!statusKnown || (!hosted && !loop.configured && !forceLocal)))
    checkStatus();
  scene.update(dt, now / 1000);
  refreshHud(now);
}

// -------------------------------------------------------------------- events
const blurAfterPointer = (event) => {
  // Keep Space/Enter free for passing and shooting after a mouse click.
  if (event.detail > 0) event.currentTarget.blur();
};
for (const button of document.querySelectorAll(
  ".bottom-hud button, .topbar button, .side-hud button, .player-card button",
))
  button.addEventListener("click", blurAfterPointer);

$("play-toggle").onclick = () => setPlaying(!sim.human);
$("candidates-toggle").onclick = cycleArrows;
$("camera").onclick = changeCamera;
$("speed").onclick = (event) => changeSpeed(event.shiftKey ? -1 : 1);
$("pause").onclick = togglePause;
$("resume").onclick = togglePause;
$("new-match").onclick = () => newMatch();
$("match-length").onchange = (event) => {
  event.target.blur();
  newMatch(Number(event.target.value) || halfSeconds);
};
$("play-again").onclick = () => newMatch();
$("fulltime-inspect").onclick = () => $("fulltime-dialog").close();
$("pc-close").onclick = () => setFocus(null);
$("help").onclick = () => {
  touch.reset();
  $("help-dialog").showModal();
};
$("close-help").onclick = () => $("help-dialog").close();
$("help-dialog").addEventListener("click", (event) => {
  if (event.target === $("help-dialog")) $("help-dialog").close();
});
for (const [toggle, card, name] of [
  ["radar-toggle", "radar", "tactics board"],
  ["feed-toggle", "feed", "Jev feed"],
])
  $(toggle).onclick = () => {
    const collapsed = $(card).classList.toggle("collapsed");
    $(toggle).setAttribute("aria-expanded", String(!collapsed));
    const label = `${collapsed ? "Show" : "Hide"} ${name}`;
    $(toggle).setAttribute("aria-label", label);
    tooltips.set($(toggle), label);
    due.radar = 0;
  };
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("Use your browser’s fullscreen shortcut.");
  }
};
document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  $("fullscreen").innerHTML = icon(on ? "minimize" : "maximize");
  $("fullscreen").setAttribute("aria-label", on ? "Exit fullscreen" : "Enter fullscreen");
  tooltips.set($("fullscreen"), $("fullscreen").getAttribute("aria-label"));
  refreshIcons();
});
window.addEventListener("resize", () => scene?.resize?.());

window.addEventListener("keydown", (event) => {
  if (loading || event.metaKey || event.ctrlKey || event.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
  const playing = !!sim.human;
  const onButton = !!event.target.closest?.("button, a");
  if (onButton && ["Space", "Enter"].includes(event.code) && !playing) return;
  if (playing) {
    if (isMoveKey(event.code) || ["Space", "Enter", "ShiftLeft", "ShiftRight"].includes(event.code)) {
      event.preventDefault();
      if (onButton) event.target.blur();
    }
    input.press(event.code);
  }
  if (event.repeat) return;
  if (playing) {
    if (event.code === "Space") input.queue("pass");
    if (event.code === "KeyF" || event.code === "Enter") input.queue("shoot");
    if (event.code === "KeyQ") switchPlayer();
  }
  if (event.code === "KeyJ") setPlaying(!sim.human);
  if (event.code === "KeyC") changeCamera();
  if (event.code === "KeyP") togglePause();
  if (event.code === "KeyK") cycleArrows();
  if (event.code === "Comma") changeSpeed(-1);
  if (event.code === "Period") changeSpeed(1);
  if (event.code === "Escape" && focusId) setFocus(null);
  if (event.key === "?") {
    event.preventDefault();
    touch.reset();
    input.clear();
    $("help-dialog").showModal();
  }
});
window.addEventListener("keyup", (event) => input.release(event.code));
window.addEventListener("blur", () => input.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) input.clear();
});

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    loop.enabled = false;
    radar.dispose();
    tooltips.dispose();
    touch.dispose();
    auth.dispose();
    window.removeEventListener("focus", recheckOnFocus);
    document.removeEventListener("visibilitychange", recheckOnFocus);
    dockObserver.disconnect();
    scene.dispose();
  });

// Inspector "Session" tab: hosted account info, when there is any.
const inspectorData = inspector.data.bind(inspector);
inspector.data = () => {
  const data = inspectorData();
  if (inspector.tab !== "session" || !hosted) return data;
  return {
    ...data,
    hosted: {
      auth: hosted.authenticated ? "signed_in" : "signed_out",
      providers: hosted.providers,
      user_id: hosted.user?.id ?? null,
      provider: hosted.user?.provider ?? null,
      credits: hosted.credits ?? null,
      hold,
      loop_held: loop.held ?? null,
      held_decisions: loop.tally.held ?? 0,
    },
  };
};

// ---------------------------------------------------------------------- start
const seedParam = Number(params.get("seed"));
buildMatch(Number.isFinite(seedParam) && params.has("seed") ? seedParam : randomSeed());
$("match-length").value = String(halfSeconds);
tooltips.set($("match-length"), `Match length · ${matchLengthLabel(halfSeconds)}`);
syncPause();
requestAnimationFrame(frame);
checkStatus();
finishLoading().catch(loadingFailed);

// Live handles for the console, the HUD harness and browser checks.
const app = {
  get sim() {
    return sim;
  },
  get scene() {
    return scene;
  },
  get loop() {
    return loop;
  },
  setFocus,
  setPlaying,
  togglePause,
  newMatch,
  showFulltime,
  toast,
  inspector,
};
globalThis.jevball = app;
export { app };
