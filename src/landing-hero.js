// The live match behind the landing headline. Runs entirely on the local policy:
// this module never touches /api/decide. Loaded lazily from landing.js.
import { Simulation } from "./simulation.js";
import { MatchScene } from "./scene.js";

const STEP = 1 / 60;
const SPEED = 0.75;
const FULLTIME_HOLD_MS = 6000;
const PHASE_LABEL = { halftime: "HT", fulltime: "FT" };

export async function mountHero({ stage }) {
  const canvas = stage.querySelector("canvas");
  const labels = stage.querySelector("#hero-labels");
  const scoreEl = document.getElementById("hb-score");
  const clockEl = document.getElementById("hb-clock");
  const tickerEl = document.getElementById("hb-ticker");
  const params = new URLSearchParams(location.search);
  const halfSeconds = Math.max(5, Number(params.get("herohalf")) || 600);

  let sim, scene;
  let visible = true,
    raf = 0,
    last = 0,
    acc = 0,
    hudAt = 0,
    fulltimeAt = 0,
    swapping = false,
    shownScore = "",
    shownDecisionAt = -1;

  async function kickOff() {
    sim = new Simulation((Math.random() * 2 ** 31) | 0, { halfSeconds });
    scene = new MatchScene(canvas, sim, labels);
    await scene.ready;
    scene.setCamera(scene.cameraNames.includes("Cinematic") ? "Cinematic" : "Broadcast");
    if (typeof scene.setCandidatesMode === "function") scene.setCandidatesMode("all");
    else scene.setCandidatesVisible(true);
    shownScore = "";
    shownDecisionAt = -1;
    fulltimeAt = 0;
    framedFor = "";
    frameShot();
  }

  // The headline owns the left (desktop) or bottom (phone) of the hero, so slide the camera's
  // principal point the other way: the ball stays in the clear part of the frame.
  let framedFor = "";
  function frameShot() {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const key = `${w}x${h}`;
    if (!w || !h || key === framedFor || !scene?.camera?.setViewOffset) return;
    framedFor = key;
    const wide = w > 940;
    scene.camera.setViewOffset(w, h, wide ? -0.17 * w : 0, wide ? 0.04 * h : 0.05 * h, w, h);
  }

  async function nextMatch() {
    swapping = true;
    stage.classList.remove("is-live");
    await new Promise((resolve) => setTimeout(resolve, 950));
    scene.dispose();
    labels.replaceChildren();
    await kickOff();
    swapping = false;
    stage.classList.add("is-live");
    last = 0;
  }

  function hud(now) {
    if (now - hudAt < 250) return;
    hudAt = now;
    const score = `${sim.score[0]}–${sim.score[1]}`;
    if (score !== shownScore) {
      if (shownScore) {
        scoreEl.classList.remove("flip");
        void scoreEl.offsetWidth;
        scoreEl.classList.add("flip");
      }
      scoreEl.textContent = shownScore = score;
    }
    clockEl.textContent = PHASE_LABEL[sim.phase] ?? `${sim.clock.minute}'`;

    // Latest decision near the ball, in the Jev feed's format.
    let latest = null;
    for (const p of sim.players) {
      const d = p.decision;
      if (!d || d.source === "rule" || !d.probabilities) continue;
      if (!latest || d.at > latest.decision.at) latest = p;
    }
    const owner = sim.owner?.();
    if (owner?.decision?.probabilities && owner.decision.source !== "rule") latest = owner;
    if (latest && latest.decision.at !== shownDecisionAt) {
      shownDecisionAt = latest.decision.at;
      const d = latest.decision;
      const pct = Math.round((d.probabilities[d.choice] ?? 0) * 100);
      tickerEl.replaceChildren(
        Object.assign(document.createElement("b"), { textContent: `${latest.id} ${latest.role}` }),
        ` → ${d.choice} · ${pct}% · local`,
      );
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (swapping) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    acc += dt * SPEED;
    let steps = 0;
    while (acc >= STEP && steps < 6) {
      sim.step(STEP);
      for (const p of sim.decisionDue()) sim.decideLocally(p);
      acc -= STEP;
      steps++;
    }
    if (steps === 6) acc = 0;
    frameShot();
    scene.update(dt, now / 1000);
    hud(now);
    if (sim.phase === "fulltime") {
      fulltimeAt ||= now;
      if (now - fulltimeAt > FULLTIME_HOLD_MS)
        nextMatch().catch((error) => {
          console.warn("Hero rematch failed", error);
          stop();
        });
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function sync() {
    const run = visible && !document.hidden;
    if (run && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) stop();
  }

  await kickOff();
  stage.classList.add("is-live");
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      sync();
    },
    { threshold: 0.02 },
  ).observe(stage);
  document.addEventListener("visibilitychange", sync);
  addEventListener("resize", () => scene?.resize(), { passive: true });
  sync();
}
