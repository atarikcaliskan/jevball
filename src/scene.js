import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { assetManager, assetsReady, disposeMaterials } from "./materials.js";
import { renderProfile } from "./render-profile.js";
import { Stadium } from "./scene-stadium.js";
import { Players } from "./scene-players.js";
import { Ball } from "./scene-ball.js";
import { CandidateVectors } from "./scene-vectors.js";
import { CAMERA_NAMES, CameraRig } from "./scene-cameras.js";

let daylight;
function daylightEnvironment() {
  return (daylight ||= new HDRLoader(assetManager)
    .loadAsync("/textures/daylight.hdr")
    .then((texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      return texture;
    })
    .catch((error) => {
      daylight = null; // a later attempt (retry, next match) may succeed
      throw error;
    }));
}

/** Stand-in sky until (or instead of) the HDR: a clear-day gradient close to the HDR's blues. */
function gradientSky() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(2000, 24, 12),
    new THREE.ShaderMaterial({
      uniforms: {
        zenith: { value: new THREE.Color("#2359b5") },
        horizon: { value: new THREE.Color("#b9d6ee") },
        ground: { value: new THREE.Color("#8a9684") },
        sun: { value: SUN_DIRECTION },
      },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sun; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 sky = mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
          sky += vec3(1.0, 0.93, 0.8) * (0.22 * pow(max(dot(d, sun), 0.0), 6.0) + 1.6 * pow(max(dot(d, sun), 0.0), 900.0));
          gl_FragColor = vec4(mix(sky, ground, smoothstep(0.0, -0.06, d.y)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  mesh.name = "sky-fallback";
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// A new match builds a new MatchScene on the same canvas: keep one WebGL renderer per canvas.
const renderers = new WeakMap();
function rendererFor(canvas) {
  let renderer = renderers.get(canvas);
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: renderProfile.antialias,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderers.set(canvas, renderer);
  }
  return renderer;
}

const SUN_DIRECTION = new THREE.Vector3(-42, 120, 52).normalize();
const SHADOW_EXTENT = {
  Broadcast: 42,
  Tactical: 66,
  Follow: 30,
  "Behind goal": 58,
  Cinematic: 58,
};

export class MatchScene {
  constructor(canvas, sim, labelsEl) {
    this.canvas = canvas;
    this.sim = sim;
    this.labelsEl = labelsEl || null;
    this.cameraNames = [...CAMERA_NAMES];
    this.disposed = false;
    this.renderer = rendererFor(canvas);
    this.renderer.setPixelRatio(
      Math.min(globalThis.devicePixelRatio || 1, renderProfile.pixelRatio),
    );
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 2400);
    this.viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
    this.resizeObserver = new ResizeObserver(([entry]) => {
      this.viewport = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      this.measured = false;
    });
    this.resizeObserver.observe(canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#a9cbe8");
    this.scene.fog = new THREE.Fog("#b7c6d0", 170, 1500);
    this.hemisphere = new THREE.HemisphereLight("#d5e4f8", "#56603f", 0.55);
    this.scene.add(this.hemisphere);
    this.sky = gradientSky();
    this.scene.add(this.sky);
    this.sun = new THREE.DirectionalLight("#fff0d9", 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(
      renderProfile.shadowSize,
      renderProfile.shadowSize,
    );
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2.2;
    this.shadowExtent = 0;
    this.scene.add(this.sun, this.sun.target);
    // Light-space axes used to snap the shadow frustum to whole texels (no shimmer while tracking).
    this.lightRight = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION)
      .normalize();
    this.lightUp = new THREE.Vector3()
      .crossVectors(SUN_DIRECTION, this.lightRight)
      .normalize();
    this.shadowFocus = new THREE.Vector3();

    this.stadium = new Stadium(this.scene);
    this.players = new Players(this.scene);
    this.ball = new Ball(this.scene);
    this.vectors = new CandidateVectors(this.scene, this.labelsEl);
    this.cameras = new CameraRig(this.camera, canvas);
    this.lastPhase = sim.phase;
    this.lastScore = [sim.score?.[0] ?? 0, sim.score?.[1] ?? 0];
    this.ready = this.prepare();
  }
  get cameraName() {
    return this.cameras.name;
  }
  /** "all" | "selected" | "off" — see setCandidatesMode. */
  get candidatesMode() {
    return this.vectors.mode;
  }
  useDaylight(texture) {
    if (this.disposed) return;
    this.scene.environment = this.scene.background = texture;
    this.scene.environmentIntensity = 0.62;
    this.scene.backgroundIntensity = 0.85;
    this.scene.backgroundBlurriness = 0.02;
    this.hemisphere.intensity = 0.55;
    this.sky.visible = false;
    this.fallbackEnvironment?.dispose();
    this.fallbackEnvironment = null;
  }
  /** No HDR: light the scene from the gradient sky and lean harder on the hemisphere fill. */
  useFallbackSky() {
    if (this.disposed || this.scene.environment) return;
    this.hemisphere.intensity = 0.8;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const probe = new THREE.Scene();
      const sky = gradientSky();
      probe.add(sky);
      this.fallbackEnvironment = pmrem.fromScene(probe, 0.02, 1, 5000); // the dome is 2 km out
      this.scene.environment = this.fallbackEnvironment.texture;
      this.scene.environmentIntensity = 1.0;
      sky.geometry.dispose();
      sky.material.dispose();
      pmrem.dispose();
    } catch (error) {
      this.hemisphere.intensity = 1.35;
      console.warn("Fallback sky lighting skipped", error);
    }
  }
  async prepare() {
    const environment = daylightEnvironment()
      .then((texture) => this.useDaylight(texture))
      .catch((error) => {
        console.warn("Daylight environment unavailable", error);
        this.useFallbackSky();
        // One quiet retry: the usual cause is a request cut short by a reload.
        setTimeout(() => {
          if (this.disposed) return;
          daylightEnvironment()
            .then((texture) => this.useDaylight(texture))
            .catch(() => {});
        }, 2500);
      });
    // Board, scoreboard and shirt-number canvases want the brand font if the page provides it.
    const redrawText = () => {
      if (this.disposed) return;
      this.stadium.redrawText();
      this.players.redrawText();
    };
    const fonts = globalThis.document?.fonts
      ? Promise.race([
          Promise.all([
            document.fonts.load('700 64px "Barlow Condensed"'),
            document.fonts.load('600 30px "Barlow Condensed"'),
          ]),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]).catch(() => {})
      : Promise.resolve();
    await Promise.all([environment, fonts]);
    await assetsReady();
    if (this.disposed) return;
    redrawText();
    // Fonts that arrive after the first paint (slow network) get one more redraw.
    if (
      globalThis.document?.fonts &&
      !document.fonts.check('700 64px "Barlow Condensed"')
    )
      document.fonts.ready
        .then(() => document.fonts.load('700 64px "Barlow Condensed"'))
        .then((faces) => faces?.length && redrawText())
        .catch(() => {});
    this.frame(0, this.sim.time || 0, false);
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (error) {
      console.warn("Shader warm-up skipped", error);
    }
    if (!this.disposed) this.frame(0, this.sim.time || 0, true);
  }
  setCamera(name) {
    const wanted = CAMERA_NAMES.find(
      (n) => n.toLowerCase() === String(name).toLowerCase(),
    );
    if (wanted) this.cameras.set(wanted);
    return this.cameras.name;
  }
  nextCamera() {
    return this.cameras.next();
  }
  /**
   * Decision arrows: "all" = every option ribbon + chips + focus tag, "selected" = only the chosen
   * ribbon with its chip, "off" = none (the YOU tag and the ground rings stay). Returns the mode.
   */
  setCandidatesMode(mode) {
    return this.vectors.setMode(String(mode).toLowerCase());
  }
  /** Back-compat alias: true → "all", false → "selected". */
  setCandidatesVisible(visible) {
    this.setCandidatesMode(visible ? "all" : "selected");
  }
  setFocus(playerId) {
    this.vectors.setFocus(playerId);
  }
  /** `{ right:{x,y}, forward:{x,y} }` — screen-right / screen-up on the pitch, SIM coordinates. */
  cameraBasis() {
    return this.cameras.cameraBasis();
  }
  /** Crowd of `team` (0 home, 1 away) bounces for a few seconds. Also triggered on `phase === "goal"`. */
  celebrate(team, seconds) {
    this.stadium.celebrate(team, seconds);
  }
  resize() {
    this.renderer.setPixelRatio(
      Math.min(globalThis.devicePixelRatio || 1, renderProfile.pixelRatio),
    );
    this.viewport = {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
    };
    this.measured = false;
    this.fit();
  }
  fit() {
    const { width, height } = this.viewport;
    if (!width || !height) return false;
    const ratio = this.renderer.getPixelRatio();
    if (
      this.canvas.width !== Math.floor(width * ratio) ||
      this.canvas.height !== Math.floor(height * ratio)
    ) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    if (!this.measured) {
      this.vectors.measure(this.canvas);
      this.measured = true;
    }
    return true;
  }
  updateShadow(dt) {
    const want = SHADOW_EXTENT[this.cameras.name] || 42;
    const camera = this.sun.shadow.camera;
    if (!this.shadowExtent) this.shadowExtent = want;
    else
      this.shadowExtent +=
        (want - this.shadowExtent) * (1 - Math.exp(-Math.min(dt, 0.1) * 3));
    // Quantise the extent so the projection is not rebuilt every frame during a blend.
    const extent = Math.round(this.shadowExtent * 2) / 2;
    if (camera.right !== extent) {
      camera.left = camera.bottom = -extent;
      camera.right = camera.top = extent;
      camera.near = 20;
      camera.far = 330;
      camera.updateProjectionMatrix();
    }
    const f = this.shadowFocus.copy(this.cameras.target);
    const slack = Math.max(0, 62 - extent);
    f.x = Math.min(slack, Math.max(-slack, f.x));
    f.z = Math.min(slack * 0.6, Math.max(-slack * 0.6, f.z));
    f.y = 0;
    const texel = (extent * 2) / renderProfile.shadowSize;
    const r = f.dot(this.lightRight),
      u = f.dot(this.lightUp);
    f.addScaledVector(this.lightRight, Math.round(r / texel) * texel - r);
    f.addScaledVector(this.lightUp, Math.round(u / texel) * texel - u);
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(SUN_DIRECTION, 170);
  }
  /** Render one frame; reads the simulation directly. */
  update(dt, nowSeconds) {
    this.frame(dt, nowSeconds, true);
  }
  frame(dt, now, draw) {
    if (this.disposed || !this.fit()) return;
    const sim = this.sim;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    now = Number.isFinite(now) ? now : performance.now() / 1000;
    if (sim.phase !== this.lastPhase) {
      if (sim.phase === "goal") {
        const team =
          (sim.score?.[0] ?? 0) !== this.lastScore[0]
            ? 0
            : (sim.score?.[1] ?? 0) !== this.lastScore[1]
              ? 1
              : sim.ball?.lastTouchTeam;
        this.stadium.celebrate(team);
      }
      this.lastPhase = sim.phase;
    }
    this.lastScore[0] = sim.score?.[0] ?? 0;
    this.lastScore[1] = sim.score?.[1] ?? 0;
    this.stadium.update(sim, dt, now);
    this.cameras.update(sim, dt);
    this.players.update(sim, dt, now, this.camera);
    this.ball.update(sim, dt, this.camera);
    this.updateShadow(dt);
    this.vectors.update(
      sim,
      this.camera,
      this.viewport.width,
      this.viewport.height,
      dt,
      now,
    );
    if (draw) this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.cameras.dispose();
    this.vectors.dispose();
    this.players.dispose();
    this.ball.dispose();
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.isInstancedMesh) o.dispose();
      const list = Array.isArray(o.material)
        ? o.material
        : o.material
          ? [o.material]
          : [];
      for (const material of list) {
        material.map?.dispose();
        material.dispose();
      }
    });
    this.sun.shadow.map?.dispose();
    this.fallbackEnvironment?.dispose();
    this.fallbackEnvironment = null;
    disposeMaterials();
    this.scene.environment = this.scene.background = null;
    this.renderer.renderLists.dispose();
  }
}
