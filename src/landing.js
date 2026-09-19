// JevBall landing page: light interactions only. The 3D hero lives in landing-hero.js and is
// fetched with a dynamic import() so first paint never waits for three.js.
import { FORMATIONS, TEAMS } from "./pitch.js";
import { SUPPORT_URL } from "./support.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------------------ nav */
function nav() {
  const bar = $("#nav");
  const onScroll = () => bar.classList.toggle("is-stuck", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const links = new Map(
    $$(".bug-links a").map((a) => [a.getAttribute("href").slice(1), a]),
  );
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const [id, a] of links)
          a.toggleAttribute("aria-current", false),
            id === entry.target.id && a.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "-45% 0px -50% 0px" },
  );
  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) spy.observe(section);
  }
  const hero = $("#top");
  if (hero)
    new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting)
          for (const a of links.values()) a.removeAttribute("aria-current");
      },
      { rootMargin: "-45% 0px -50% 0px" },
    ).observe(hero);
}

/* -------------------------------------------------------- reveal wipes */
function reveals() {
  const items = $$(".reveal");
  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    for (const el of items) el.classList.add("in");
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      let i = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.style.setProperty("--d", `${Math.min(i++, 4) * 70}ms`);
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  for (const el of items) seen.observe(el);
}

/* --------------------------------------- tactics board ↔ JSON crosslink */
function board() {
  const figure = $(".board");
  const slab = $("#code-slab");
  if (!figure || !slab) return;
  const all = $$("[data-opt]");
  const heat = (id) => {
    figure.classList.toggle("is-probing", Boolean(id));
    for (const el of all) el.classList.toggle("is-hot", el.dataset.opt === id);
  };
  for (const el of all) {
    el.addEventListener("pointerenter", () => heat(el.dataset.opt));
    el.addEventListener("pointerleave", () => heat(null));
  }

  const tabs = $$('[role="tab"]', slab);
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      select(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
    });
  }
}

/* ------------------------------------------------ line-up from pitch.js */
const SVG = "http://www.w3.org/2000/svg";
const L = 1050,
  W = 680;
const ROLE_NAMES = {
  GK: "Goalkeeper",
  RB: "Right back",
  LB: "Left back",
  CB: "Centre back",
  DM: "Holding mid",
  CM: "Centre mid",
  RM: "Right mid",
  LM: "Left mid",
  AM: "Attacking mid",
  RW: "Right wing",
  LW: "Left wing",
  ST: "Striker",
};

function lineup() {
  const mount = $("#lineup-pitch");
  if (!mount) return;
  const shapes = ["4-4-2", "4-3-3"]; // Simulation defaults: home 4-4-2, away 4-3-3
  const squads = TEAMS.map((team, t) =>
    FORMATIONS[shapes[t]].map((slot) => ({
      ...slot,
      team,
      t,
      id: `${team.prefix}${slot.number}`,
    })),
  );

  // Team sheets
  squads.forEach((squad, t) => {
    const list = $(t ? "#sheet-away" : "#sheet-home");
    list.replaceChildren(
      ...[...squad]
        .sort((a, b) => a.number - b.number)
        .map((p) => {
          const li = document.createElement("li");
          li.dataset.player = p.id;
          li.innerHTML = `<span class="n">${p.number}</span><span>${ROLE_NAMES[p.role] ?? p.role}</span><span class="id">${p.id}</span>`;
          return li;
        }),
    );
  });

  const readout = $("#readout-code");
  const label = $(".readout-label");
  const show = (p) => {
    for (const el of $$("[data-player]"))
      el.classList.toggle("is-hot", el.dataset.player === p?.id);
    if (!p) return;
    label.textContent = `${p.team.name} · #${p.number} · ${ROLE_NAMES[p.role] ?? p.role}`;
    readout.textContent = `questions.${p.id} → { type: "choice", instructions: "You are ${p.id} (${p.team.id} ${p.role}). …", criteria: { ≤ 14 options } }`;
  };

  const narrow = matchMedia("(max-width: 640px)");
  const draw = () => {
    const vertical = narrow.matches;
    // Pitch space: x along the length (home goal at 0), y across. Vertical puts home at the bottom.
    const pt = (x, y) => (vertical ? [y, L - x] : [x, y]);
    const [vw, vh] = vertical ? [W, L] : [L, W];
    const el = (name, attrs, parent) => {
      const node = document.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      parent?.append(node);
      return node;
    };
    const svg = el("svg", {
      viewBox: `0 0 ${vw} ${vh}`,
      role: "img",
      "aria-label":
        "Starting shapes: Jev United in red, 4-4-2, against System One FC in blue, 4-3-3. Every disc is one Jev question.",
    });
    const rect = (x0, y0, x1, y1, cls, parent) => {
      const [ax, ay] = pt(x0, y0),
        [bx, by] = pt(x1, y1);
      return el(
        "rect",
        {
          x: Math.min(ax, bx),
          y: Math.min(ay, by),
          width: Math.abs(bx - ax),
          height: Math.abs(by - ay),
          class: cls,
        },
        parent,
      );
    };
    for (let i = 0; i < 12; i += 2) rect(i * 87.5, 0, (i + 1) * 87.5, W, "stripe", svg);
    const lines = el("g", { class: "lines" }, svg);
    rect(0, 0, L, W, "", lines);
    const [hx0, hy0] = pt(L / 2, 0),
      [hx1, hy1] = pt(L / 2, W);
    el("path", { d: `M${hx0} ${hy0}L${hx1} ${hy1}` }, lines);
    const [cx, cy] = pt(L / 2, W / 2);
    el("circle", { cx, cy, r: 91.5 }, lines);
    for (const side of [0, 1]) {
      const gx = side ? L : 0,
        dir = side ? -1 : 1;
      rect(gx, W / 2 - 201.6, gx + dir * 165, W / 2 + 201.6, "", lines);
      rect(gx, W / 2 - 91.6, gx + dir * 55, W / 2 + 91.6, "", lines);
      // penalty arc: the part of the 9.15 m circle outside the box
      const [ax, ay] = pt(gx + dir * 165, W / 2 - 73),
        [bx, by] = pt(gx + dir * 165, W / 2 + 73);
      const sweep = vertical ? (side ? 1 : 0) : side ? 0 : 1;
      el("path", { d: `M${ax} ${ay}A91.5 91.5 0 0 ${sweep} ${bx} ${by}` }, lines);
    }

    const r = vertical ? 31 : 25;
    for (const squad of squads)
      for (const p of squad) {
        const depth = ((p.ax + 1) / 1.5) * 425 + 38; // own goal line → just short of halfway
        const x = p.t ? L - depth : depth;
        const y = W / 2 + p.ay * (W / 2 - 58) * (p.t ? -1 : 1);
        const [px, py] = pt(x, y);
        const g = el("g", { class: "p", transform: `translate(${px} ${py})`, "data-player": p.id }, svg);
        const keeper = p.role === "GK";
        el("circle", { r: r + 7, class: "ring" }, g);
        el("circle", { r, fill: keeper ? p.team.colors.keeper : p.team.colors.shirt }, g);
        const num = el("text", { class: `num${keeper ? " dark" : ""}`, y: vertical ? 12 : 10.5 }, g);
        num.textContent = p.number;
        const role = el("text", { class: "role", y: r + (vertical ? 26 : 21) }, g);
        role.textContent = p.role;
        g.addEventListener("pointerenter", () => show(p));
        g.addEventListener("click", () => show(p));
      }
    mount.replaceChildren(svg);
    show(squads[0].find((p) => p.number === 9));
  };
  draw();
  narrow.addEventListener("change", draw);
}

/* ---------------------------------------------------------- copy button */
function copyButton() {
  const button = $("#copy-btn");
  if (!button) return;
  const commands = [
    "npm ci",
    "cp .env.example .env",
    "# set TYPESAFE_API_KEY in .env",
    "npm run dev",
  ].join("\n");
  const label = $("#copy-label"),
    status = $("#copy-status");
  let timer;
  button.addEventListener("click", async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(commands);
    } catch {
      ok = false;
      const range = document.createRange();
      range.selectNodeContents($("#term-code"));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    label.textContent = ok ? "Copied" : "Selected";
    status.textContent = ok
      ? "Commands copied to the clipboard"
      : "Commands selected. Press Ctrl or Command C to copy";
    button.classList.toggle("is-done", ok);
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = "Copy";
      status.textContent = "";
      button.classList.remove("is-done");
    }, 2200);
  });
}

/* ----------------------------------------------------------------- hero */
function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function hero() {
  const stage = $("#hero-stage");
  const note = $("#hb-note");
  if (!stage) return;
  const fallback = (message) => {
    stage.classList.add("is-static");
    $("#hero-bug")?.classList.add("is-static");
    if (note) note.textContent = message;
  };
  if (reducedMotion.matches)
    return fallback("Reduced motion is on, so the live match is paused here. It plays in full on the match page.");
  if (!webglAvailable())
    return fallback("This browser has no WebGL, so you're seeing the tactics board instead of the live match.");
  const start = () =>
    import("./landing-hero.js")
      .then(({ mountHero }) => mountHero({ stage }))
      .catch((error) => {
        console.warn("Hero match unavailable", error);
        fallback("The live match couldn't start here. It plays in full on the match page.");
      });
  // Let first paint and fonts settle before pulling three.js.
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 1200 });
  else setTimeout(start, 200);
}

nav();
reveals();
board();
lineup();
copyButton();
hero();

// The Sponsor button exists only when there is somewhere to send people.
if (SUPPORT_URL)
  for (const item of document.querySelectorAll("[data-support]")) {
    item.querySelector("a").href = SUPPORT_URL;
    item.hidden = false;
  }
