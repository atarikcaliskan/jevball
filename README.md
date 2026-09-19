# JevBall

<p align="center"><img src="public/brand/jevball-mark.svg" alt="" width="64" height="64" /></p>

**22 Jev models, one match.** JevBall is a football match in a 3D stadium where each of the 22 players is an independent decision-maker powered by [Jev by TypeSafe AI](https://typesafe.ai/) (Jev is TypeSafe AI's System One model). Watch the match, open any player's head to see the options it weighed, or press **J** and take over a player yourself.

The philosophy: geometry, physics and candidate generation stay local; Jev only picks among typed, pre-computed candidates and returns probabilities.

## How it works

**One choice question per player.** A few times per second each player gets a fresh decision: the simulation works out that player's realistic options locally — `shoot`, `pass_h7`, `through_h9`, `dribble_fwd`, `press`, `mark_a10`, `run_behind`, `gk_rush` … at most 14 — each with a short label and numeric features (distance, lane clearance, receiver space, success estimate, xG, ETA versus the nearest opponent, offside margin). Jev answers a `choice` question over those option ids and returns a probability for each. The chosen option becomes the player's intent; kicks are executed immediately.

**One request per tick for everybody.** All players whose decision is due are batched into a single `POST /v1/systemone` call: the match state (clock, score, phase, ball, 22 player rows) is sent once, followed by one question per player (up to 10 per batch, at most 2 requests in flight). The browser never talks to TypeSafe directly — it posts candidate tables to the local `/api/decide` endpoint, the dev server validates them, builds the Jev payload itself and keeps the API key server-side.

**Cadence.** The ball carrier decides every 0.30 s of match time, players within 15 m of the ball every 0.55 s, everyone else every 1.2 s; a change of possession or a restart pulls everyone in with a small stagger. The decision loop ticks every 250 ms at 1× and below, and proportionally faster once the match clock outruns real time (about 111 ms at 3×), because decisions fall due in match time — so a faster match also means more Jev requests per real second.

**Reflexes stay local.** Meeting a pass, keeper save attempts, the first touch on receiving the ball, restart distances and offside avoidance are rules in the simulation — a model round trip is too slow for them and there is nothing to choose. A decision with a single legal option is never sent either.

**Play never stalls.** If an answer is late (0.9 s, or 0.45 s for the carrier), rate-limited, or fails, the player falls back to the built-in local policy (a utility + softmax over the same candidates). Without an API key the whole match runs on that local policy — free play, nothing is sent anywhere.

**See it.** The decision arrows draw the focused player's options on the pitch like chalk on a tactics board: white for ordinary options, orange for risky ones, red for shots and floodlight yellow for the one that was chosen, with probability chips. *Arrows* (**K**) cycles **All options → Chosen only → Off**; *Off* also hides the chips and name tags (the ring under the player you control stays), and the choice is remembered in `localStorage`. Click a player on the tactics board to focus it: the lower-third player graphic shows every option as a probability bar — the chosen one in yellow — and marks what the local policy would have picked, so you can compare the two. The *Jev feed* is a minute-stamped rail of decisions around the ball (`34' h8 CM pass h9 62% JEV 143 ms`, badge `JEV` / `LOCAL` / `RULE`) and match events. **Under the hood** (the `{ }` button) shows the exact Jev payload of the last batch, the response, every player's latest decision, the full match state and session telemetry, live at 4 Hz, with Freeze / Copy / Download.

### What does it cost?

Measured against the live API (September 2026, `npm run test:jev`, seed 42, 30 match-seconds, the same batching and triage rules the browser uses): **70 calls, 0 errors, 0 invalid answers, 366 ms average latency, ≈1,700 billed input tokens per call, $0.0051 total — about $0.01 per match-minute**. The first version of the payload cost $0.042 per match-minute; the difference comes from wording each option's facts compactly instead of sending JSON tables (Jev bills roughly one token per digit or bracket), sending the playbook once, and not asking Jev about players who are far from the ball and only have positional options. Jev's pick matched the local policy's pick 44 % of the time (30 % on the ball). These are short samples, not a benchmark: rate-limit behaviour over a full match and decision quality have not been studied in depth. Pricing: **$0.042 per million input tokens**, output free. The control strip shows the real session total computed from the token usage Jev reports; hover it for averages per call.

## Run locally

```sh
git clone https://github.com/atarikcaliskan/jevball.git
cd jevball
npm ci
cp .env.example .env
# Set TYPESAFE_API_KEY in .env.
npm run dev
```

Add your own [TypeSafe AI](https://typesafe.ai/) API key to `.env`:

```dotenv
TYPESAFE_API_KEY=your_key_here
```

Open [localhost:5173](http://localhost:5173) for the landing page; the match itself lives at [`/play.html`](http://localhost:5173/play.html). Run locally there is no login, signup or credit system (see [Hosted mode](#hosted-mode) for the public deployment). Jev calls use your own key and TypeSafe account billing. The key stays server-side in the gitignored `.env`; never use a `VITE_` variable for it. Restart the dev server after changing `.env` (the page re-checks `/api/status` on its own). The same applies to `npm run preview` after `npm run build`.

**No key? It still plays.** The control strip reads *Local policy · no API key* and all 22 players use the local policy.

URL parameters: `?seed=1234` (reproducible match), `?half=60` (seconds per half; the picker offers 2 × 1, 3 and 5 min), `?local=1` (force the local policy even with a key), `?cam=tactical` (start camera: `broadcast`, `tactical`, `follow`, `behindgoal`), `?speed=1.5` (match speed, snapped to the nearest step: `0.5`, `0.75`, `1`, `1.5`, `2`, `3`; default `1`), `?arrows=all|selected|off` (decision arrows; overrides the remembered mode). Example: `/play.html?seed=6&speed=1&arrows=selected`.

## Hosted mode

The hosted deployment is a public site: the landing page and the match are open to everyone, and the match runs on the free local policy.
Signing in with GitHub or Google is needed only to spend Jev credit — it switches all 22 players to Jev.
Each account gets a one-time free grant of play credit (`PLAY_GRANT_USD`; the HUD shows what is left next to the session cost).
There are no purchases; when the free credit is used the local policy takes over and the match plays on.
The Jev key stays server-side in the Worker; spending is tracked in a per-user ledger and bounded by a global daily cap.
Locally none of this appears: `/api/status` says `auth_required: false` and there is no sign-in UI.
Details: [docs/AUTH.md](docs/AUTH.md) (contract) and `docs/hosting.md` (deployment).

## Controls

| Key | Action |
| --- | --- |
| **J** | Take control of a player / hand it back to Jev (home striker by default, or the focused home player) |
| **W A S D** / arrows | Move, relative to the camera |
| **Shift** | Sprint |
| **Space** | Pass |
| **F** / **Enter** | Shoot |
| **Q** | Switch to the player nearest the ball |
| **K** | Decision arrows: All options → Chosen only → Off |
| **C** | Cycle camera: Broadcast, Tactical, Follow, Behind goal |
| **,** / **.** | Match speed one step slower / faster |
| **P** | Pause |
| **Esc** | Clear the focused player |
| **?** | Help |

Click a player on the tactics board (or a row in the Jev feed) to focus it.

**Match speed** steps through **0.5× · 0.75× · 1× · 1.5× · 2× · 3×** and starts at **1×**. The 1× baseline is deliberately a touch slower than real time — 0.75 match-seconds per real second — because that reads best for 22 simultaneous decision-makers; the other steps are multiples of that baseline. Match-length labels such as *2 × 3 min* (and `?half=`) are match-clock time, so at 1× a 3-minute half takes about 4 minutes of real time. Click the speed button to go one step faster (it wraps round to 0.5×), Shift+click to go one step slower; the value turns yellow whenever it is not the default. The simulation always advances in fixed 1/60 s steps, so speed changes how many steps run per frame, never the physics.

The control strip also has the camera, the JSON inspector, fullscreen and pause. On touch devices a thumbstick (push to the edge to sprint) and Pass / Shoot / Switch buttons appear while you play.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with the `/api/decide` and `/api/status` middleware |
| `npm run build` / `npm run preview` | Production build and local preview (same middleware) |
| `npm test` | Node test suite (`node --test tests/*.test.js`) |
| `npm run match` | Plays a headless match on the local policy and prints the result |
| `npm run test:jev` | Sends a real batch to Jev using the key in `.env` |

`hud-test.html` (dev server only, not part of the build) mounts the real HUD on a mock match, e.g. `/hud-test.html?jev=1&state=focus` — handy for working on the interface without the stadium.

## Look: "Matchday broadcast"

JevBall has its own identity: a TV football broadcast crossed with a coach's tactics board, laid over the daylight 3D scene. A skewed **score bug** sits top-left (team colour bars, chalk score box that flips on a goal, clock slab, two-colour possession bar, event badges that wipe in for GOAL / CORNER / FULL-TIME); brand and match controls are a slab strip top-right; the radar is a dark-turf **tactics board** with numbered magnets and the chosen option as a dashed yellow chalk arrow; the focused player is a **lower-third graphic**; the bottom is a full-width **control strip** whose yellow *PLAY AS #9* slab turns into a red *LIVE · YOU ARE h9*; full-time is a broadcast stats graphic. Tokens (green-black ink panels, chalk text, floodlight-yellow accent; Barlow Condensed / Barlow / JetBrains Mono) live in `src/theme.css` and are shared with the landing page; the rules are in [docs/THEME.md](docs/THEME.md). Focus rings are yellow, motion is short wipes and respects `prefers-reduced-motion`, and the layout reflows down to 380 px.

## Project layout

```
index.html                 landing page
play.html                  the match: loader + app shell
src/theme.css              shared "Matchday broadcast" tokens and fonts
src/main.js                game loop (fixed 60 Hz step), wiring, keys, dialogs
src/hud-auth.js            hosted sign-in, play-credit readout, account sheet (hidden locally)
src/hud-*.js               score bug, tactics board, Jev feed, player graphic, inspector, markup, formatting
src/input.js               camera-relative keyboard input for the human player
src/touch-controls.js      thumbstick + Pass / Shoot / Switch
src/style.css              the broadcast HUD
src/simulation.js          physics, rules, possession, restarts, human control
src/candidates.js          per-player candidate generation + features
src/policy.js              local policy (fallback and comparison)
src/pitch.js, src/math.js  dimensions, formations, teams, helpers
src/decision-loop.js       batches due players → /api/decide → applies answers, tally
src/jev-request.js         builds the compact Jev payload, expands the answers
src/scene*.js              three.js stadium, players, ball, candidate arrows, cameras
server/jev.js              validation + Jev call, mounted by vite.config.js
docs/ARCHITECTURE.md       the module contract
```

## Credits

- Decisions by [Jev](https://typesafe.ai/), TypeSafe AI's System One model.
- Grass, pavement and sky are CC0 assets from [Poly Haven](https://polyhaven.com); details in [public/textures/LICENSE.md](public/textures/LICENSE.md).
- Icons by [Lucide](https://lucide.dev); type set in Barlow Condensed, Barlow and JetBrains Mono.

## Creator

Created by **@atarikcaliskan** — [X](https://x.com/atarikcaliskan) · [LinkedIn](https://www.linkedin.com/in/atarikcaliskan) · [GitHub](https://github.com/atarikcaliskan).

The hosted demo runs on the creator's own Jev credit — if you enjoyed it, you can [sponsor the creator on GitHub](https://github.com/sponsors/atarikcaliskan).

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): you may use, modify and share JevBall for any **noncommercial** purpose — personal projects, research, education, hobby forks — as long as you keep the licence and the notice below. Commercial use needs the creator's permission; ask.

> Required Notice: Copyright atarikcaliskan (https://github.com/atarikcaliskan)

Third-party material keeps its own terms: the Poly Haven textures and sky are CC0 ([public/textures/LICENSE.md](public/textures/LICENSE.md)), and dependencies such as three.js and Lucide are under their own licences. "Jev" is TypeSafe AI's product name; JevBall is an unofficial fan project and is not affiliated with TypeSafe AI.
