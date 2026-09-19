// Dev harness for the 3D scene only: real Simulation + local decisions, no HUD, no Jev calls.
//   /scene-test.html?cam=Tactical&t=25&human=h9&arrows=all|selected|off&seed=7&focus=a4&cheer=0&speed=1
//   cam=Cinematic&cine=40 starts the cinematic drift 40 s in; candidates=0 is the old spelling of arrows=selected.
import { MatchScene } from "./scene.js";
import { Simulation } from "./simulation.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const STEP = 1 / 60;

const sim = new Simulation(Number(params.get("seed")) || 7, {
  halfSeconds: 180,
});
const advance = () => {
  sim.step(STEP);
  for (const p of sim.decisionDue()) sim.decideLocally(p);
};
for (let t = 0, end = Number(params.get("t")) || 0; t < end; t += STEP)
  advance();
if (params.get("human")) sim.setHuman(params.get("human"));

const scene = new MatchScene($("world-canvas"), sim, $("vector-labels"));
window.jevball = { sim, scene };
if (params.get("cam")) scene.setCamera(params.get("cam"));
const MODES = ["all", "selected", "off"];
let arrows = MODES.includes(params.get("arrows"))
  ? params.get("arrows")
  : params.get("candidates") === "0"
    ? "selected"
    : "all";
scene.setCandidatesMode(arrows);
if (params.get("cine")) scene.cameras.cine.time = Number(params.get("cine"));
if (params.get("focus")) scene.setFocus(params.get("focus"));

if (params.get("orbit")) {
  const [yaw, pitch, zoom] = params.get("orbit").split(",").map(Number);
  Object.assign(scene.cameras.input.states[scene.cameraName], {
    yaw: yaw || 0,
    pitch: pitch || 0,
    zoom: zoom || 1,
  });
}

let paused = false;
const look = params.get("look")?.split(",").map(Number);
$("cam").onclick = () => ($("cam").textContent = scene.nextCamera());
const showArrows = () => ($("cand").textContent = `Arrows: ${arrows}`);
$("cand").onclick = () => {
  arrows = scene.setCandidatesMode(
    MODES[(MODES.indexOf(arrows) + 1) % MODES.length],
  );
  showArrows();
};
showArrows();
$("human").onclick = () => (sim.human ? sim.setHuman(null) : sim.switchHuman());
$("goal").onclick = () => scene.celebrate(Math.random() < 0.5 ? 0 : 1);
$("pause").onclick = () => (paused = !paused);
$("cam").textContent = scene.cameraName;

const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));

await scene.ready;
if (params.get("cheer"))
  scene.celebrate(Number(params.get("cheer")) ? 1 : 0, 60);
const speed = Number(params.get("speed")) || 1;
let last = performance.now(),
  accumulator = 0,
  frames = 0,
  fpsAt = last,
  fps = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (sim.human) {
    const basis = scene.cameraBasis();
    const ix = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
      iy = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    sim.humanInput.mx = basis.right.x * ix + basis.forward.x * iy;
    sim.humanInput.my = basis.right.y * ix + basis.forward.y * iy;
    sim.humanInput.sprint = keys.has("ShiftLeft");
    if (keys.has("Space")) sim.humanInput.pass = true;
    if (keys.has("KeyF")) sim.humanInput.shoot = true;
  }
  if (!paused) {
    accumulator += dt * speed;
    for (let n = 0; accumulator >= STEP && n < 8; n++, accumulator -= STEP)
      advance();
    if (accumulator >= STEP) accumulator = 0;
  }
  scene.update(dt, now / 1000);
  if (look) {
    // Inspection shot: ?look=x,y,z,tx,ty,tz,fov overrides the rig for close-ups of props.
    const c = scene.camera;
    c.position.set(look[0], look[1], look[2]);
    c.lookAt(look[3], look[4], look[5]);
    c.fov = look[6] || 30;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    scene.renderer.render(scene.scene, c);
  }
  frames++;
  if (now - fpsAt > 500) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
    const info = scene.renderer.info.render;
    $("info").textContent =
      `${fps.toFixed(0)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · ${sim.clock.minute}'`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
document.body.dataset.ready = "1";
