# JevBall architecture contract

JevBall is a football (soccer) match where **each of the 22 players is an independent
Jev decision-maker**.

The philosophy: **geometry, physics and candidate generation stay local;
Jev only picks among typed, pre-computed candidates** and returns probabilities.
Without an API key the match still runs using the local policy ("free play").

Plain ES modules, no TypeScript, no framework. Dependencies: `three`, `lucide`, `vite`.
Node 22. Tests: `node --test tests/*.test.js`. Everything in `src/` except `scene*.js`,
`main.js`, UI modules must be importable in Node (no DOM, no three).

## Jev API (verified from docs.typesafe.ai)

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`

```json
{ "model": "jev-latest",
  "state": { "...any JSON..." },
  "questions": { "<key>": { "type": "choice", "instructions": "string", "criteria": { "<optionId>": "description or null" } } } }
```

Response: `{ model, answers: { "<key>": { choice, probabilities: {optionId: p}, confidence } }, usage: { input_tokens, output_tokens } }`.
Errors: 401 bad key, 422 validation, 429 rate limit (1200 req/min), 529 overloaded. Latency 70–500 ms.
Pricing: input $0.042/MTok, output free. Many questions may share one call (state is sent once) —
JevBall batches all players whose decision is due into **one request per tick**, one question per player.

## Coordinates

Sim space: `x` along pitch length (−52.5…52.5), `y` across width (−34…34), `z` height, metres.
Team 0 (home) attacks **+x** in half 1 and −x in half 2. `sim.attackDir(team)` → `+1 | -1`.
Three.js mapping (scene only): `three.x = sim.x`, `three.y = sim.z`, `three.z = sim.y`.
Angles: `facing = Math.atan2(vy, vx)` radians in sim space.

## Files and owners

| File | Owner | Purpose |
|---|---|---|
| `src/math.js` | SIM | clamp, lerp, dist, seeded rng (`mulberry32`), `pointSegmentDistance`, angle helpers |
| `src/pitch.js` | SIM | `PITCH` dimensions, `FORMATIONS`, `TEAMS` |
| `src/simulation.js` | SIM | `Simulation` class: physics, rules, possession, restarts, human control |
| `src/candidates.js` | SIM | `buildDecisionState(sim, player)` candidate generation + features |
| `src/policy.js` | SIM | `localPolicy(decisionState)` → `{choice, probabilities}` utility+softmax |
| `tests/simulation.test.js`, `tests/candidates.test.js`, `scripts/headless-match.mjs` | SIM | |
| `src/jev-request.js` | JEV | `prepareJevRequest`, `expandJevAnswers` |
| `server/jev.js` | JEV | `validBatch`, `evaluate`, `jevMiddleware` (vite dev/preview) |
| `vite.config.js` | JEV | mounts the `/api/*` middleware for dev and preview |
| `src/decision-loop.js` | JEV | browser/Node scheduler: batches due players → `/api/decide` → `applyDecision`, tally |
| `tests/jev.test.js`, `tests/fixtures/*.js`, `scripts/verify-jev.mjs` | JEV | |
| `src/scene.js` (+ `src/scene-*.js`, `src/materials.js`) | SCENE | three.js stadium, players, ball, candidate arrows, cameras |
| `index.html`, `src/main.js`, `src/style.css`, `src/hud-*.js`, `src/input.js`, `README.md` | UI | HUD, scoreboard, radar, inspector, controls, game loop |

Only touch files you own. If you need something from another owner, code against this contract.

## `src/pitch.js`

```js
export const PITCH = { length:105, width:68, halfL:52.5, halfW:34, goalWidth:7.32, goalHeight:2.44, goalDepth:2.2,
  penaltyAreaDepth:16.5, penaltyAreaWidth:40.32, goalAreaDepth:5.5, goalAreaWidth:18.32,
  centerCircle:9.15, penaltySpot:11, cornerArc:1 };
export const TEAMS = [
  { id:"home", name:"Jev United",    short:"JEV", prefix:"h", colors:{ shirt:"#e82127", shorts:"#ffffff", socks:"#e82127", keeper:"#f2b705" } },
  { id:"away", name:"System One FC", short:"SYS", prefix:"a", colors:{ shirt:"#3e6ae1", shorts:"#171a20", socks:"#3e6ae1", keeper:"#2fbf71" } },
];
// 11 slots each, attack-normalized: ax in [-1,1] (−1 own goal line, +1 opponent goal line), ay in [-1,1] (−1 left … +1 right when facing attack)
export const FORMATIONS = { "4-4-2":[{role:"GK",number:1,ax,ay}, …], "4-3-3":[…], "3-5-2":[…] };
```
Roles: `GK, LB, CB, RB, LWB, RWB, DM, CM, LM, RM, AM, LW, RW, ST`. Player ids: `h1…h11`, `a1…a11` (prefix + shirt number).

## `Simulation` (src/simulation.js)

```js
const sim = new Simulation(seed, { formations:["4-4-2","4-3-3"], halfSeconds:180 });
```
Deterministic given seed + same sequence of calls. Recommended `step(1/60)`.

Fields (read by scene/UI — keep names exact):
- `time` (s), `paused`, `seed`
- `clock: { half:1|2, elapsed, halfSeconds, minute }` (`minute` = scaled 0–90 football minute, integer)
- `phase: "kickoff"|"play"|"restart"|"goal"|"halftime"|"fulltime"`
- `restart: null | { type:"kickoff"|"throw_in"|"corner"|"goal_kick"|"free_kick", team, x, y, takerId }`
- `score: [home, away]`
- `possession: 0|1|null` team currently/last in control
- `players: Player[22]`, `ball: Ball`
- `stats: { possessionTime:[s,s], shots:[n,n], onTarget:[n,n], passes:[n,n], passesCompleted:[n,n], tackles:[n,n], saves:[n,n], corners:[n,n] }`
- `events: [{ t, minute, type, team, playerId, text }]` newest last, capped at 200. Types: `kickoff, goal, shot, save, pass, tackle, interception, throw_in, corner, goal_kick, halftime, fulltime, decision`
- `human: null | { playerId }`, `humanInput: { mx, my, sprint, pass, shoot }` (UI writes; `pass`/`shoot` are one-shot flags the sim consumes)

```
Player = { id, team, number, role, x, y, vx, vy, facing, speed, maxSpeed,
  home:{ax,ay},                     // formation slot
  intent:{ type, target:{x,y}|null, targetId:string|null, label:string },
  decision: null | { batchId, kind, choice, label, source:"jev"|"local"|"rule", probabilities, confidence, at, options }, // options = DecisionState.options, for viz
  nextDecisionAt, pending:boolean,  // pending = request in flight (set by decision loop)
  cooldown,                         // s during which it cannot win the ball
  kickT,                            // time of last kick (for animation)
  isHuman:boolean }
Ball = { x,y,z, vx,vy,vz, spin?, ownerId:string|null, lastTouchId, lastTouchTeam,
  flight: null | { kind:"pass"|"through"|"cross"|"shot"|"clear", fromId, toId|null, target:{x,y} } }
```

Methods:
- `step(dt)`
- `attackDir(team)`, `player(id)`, `teamPlayers(team)`, `owner()` → Player|null
- `decisionDue()` → Player[] needing a decision now (`time >= nextDecisionAt`, not `pending`, not human, phase allows), sorted most-urgent first (carrier, then distance to ball)
- `decisionState(player)` → `DecisionState` (delegates to `buildDecisionState`); caches on `player.lastDecisionState`
- `applyDecision(playerId, batchId, choice, meta)` → boolean. Rejects (returns false) if `batchId` doesn't match the player's latest decision state, the choice isn't an option, or `kind` no longer matches reality (e.g. lost the ball). `meta = { source, probabilities, confidence, latencyMs }`. Sets `player.intent`, `player.decision`, `nextDecisionAt`; executes kicks immediately.
- `decideLocally(player)` → builds state, runs `localPolicy`, applies with `source:"local"`. Used when no key, on error, or when a response is late.
- `sharedState()` → snapshot used once per Jev request (see below)
- `setHuman(playerId|null)`, `switchHuman()` (nearest home player to ball)
- `snapshot()` → full JSON-safe world for the inspector
- Reflexes that are **always local** (source `"rule"`): pass receiver runs to meet the ball, keeper save attempts, carrier gets an instant default intent on receiving, players respect restart distances, offside is avoided by construction (no pass option to offside teammates; `run_behind` targets are clamped to the offside line).

Decision cadence (sim seconds): carrier 0.30; within 15 m of ball 0.55; others 1.2; on possession change / restart everyone is pulled in with a small stagger. If a player has waited `> 0.9 s` (carrier `> 0.45 s`) past `nextDecisionAt` while `pending`, the sim itself calls `decideLocally` so play never stalls.

Match flow: kickoff → play → (goal → kickoff) … halftime (sides swap, 3 s) → fulltime. Out of play: throw-in (taken as a kick-in), corner, goal kick. Restarts: taker runs to the ball, opponents keep 9.15 m, taker then gets a `kind:"restart"` decision (pass options only); auto-kick after 6 s. No fouls/cards. Default `halfSeconds` 180.

## `DecisionState` (src/candidates.js)

```js
{ batch_id:"b417", player_id:"h9", team:"home", role:"ST", number:9,
  kind:"carrier"|"attack"|"defend"|"loose"|"keeper"|"restart",
  self:{ x, y,            // ATTACK-NORMALIZED: +x toward opponent goal, +y to the player's right… (x*dir, y*dir)
         speed, has_ball, pressure_m, goal_dist_m, goal_angle_deg, nearest_teammate_m },
  options:{ "<optionId>": {
      action:"shoot"|"pass"|"through"|"cross"|"dribble"|"clear"|"hold"|"press"|"mark"|"cover"|"shape"|"support"|"run"|"chase"|"gk_set"|"gk_rush"|"gk_claim",
      target_id:string|null, target:{x,y},      // WORLD coords
      label:"Pass to h7 (RM) 18 m, open",       // short human-readable, HUD only (Jev gets the features, worded — see "Jev payload")
      features:{ … finite numbers / booleans, attack-normalized where directional … },
      path:[{x,y,z}] } },                       // WORLD coords polyline for arrows (2–16 points)
  local:{ choice, probabilities } }             // local policy verdict (fallback + comparison)
```
Option ids (stable, `/^[a-z0-9_]+$/`, ≤ 14 per decision): `shoot`, `pass_<id>`, `through_<id>`, `cross`, `dribble_fwd|dribble_left|dribble_right|dribble_back`, `clear`, `hold`, `press`, `mark_<id>`, `cover`, `shape`, `support_near`, `support_wide`, `run_behind`, `chase`, `gk_set`, `gk_rush`, `gk_claim`.
Feature names by action (all optional but consistent): `dist_m, progress_m, lane_clear_m, receiver_space_m, success_p, xg, angle_deg, blockers, space_m, eta_s, opp_eta_s, mate_eta_s, danger, offside_margin_m`.
A decision with exactly one option is resolved locally and never sent to Jev.

## `sharedState()`

```js
{ minute, half, score:[h,a], phase, restart:type|null, possession:"home"|"away"|null,
  ball:{ x, y, z, vx, vy, owner:id|null, flight:kind|null },           // WORLD coords, rounded 0.1
  players:[ [id, role, x, y, vx, vy], … ] }                            // WORLD coords, rounded 0.1
```

## Jev payload (src/jev-request.js)

Billing is input tokens only. Measured live, Jev's tokenizer charges ~1 token per *character* of JSON numbers and
punctuation, ~1 per 4.3 characters of English, ~290 tokens per call before any content, and ~17 tokens per HUD-style
label. So `prepareJevRequest({ shared, decisions })` says each fact once, in words, with no pointless digits:

```js
{ model:"jev-latest",
  state:{
    units:    "legend: units, id scheme, what dist/progress/lane/space/eta/rank/pressure/mate mean (+ world frame when players are sent)",
    match:    { minute, half, home, away, possession, phase?, restart? },          // phase only when not "play"
    ball:     { x, y, owner } | { x, y, z?, vx, vy, flight? },                     // whole metres
    players?: { home:"h1 GK -48 0, h2 RB -19 17, …", away:"a1 GK 45 0, …" },       // only when an on-ball question (carrier/restart/keeper with ball) is in the batch
    playbook: { all:"…", carrier?:"…", attack?:"…", defend?:"…", loose?:"…", keeper?:"…", restart?:"…" } }, // only the kinds asked
  questions:{ h9:{ type:"choice",
    instructions:"You are h9 (home ST), carrier: speed 4 pressure 2.8 goal_dist 21 goal_angle 18 mate 12. Choose per playbook.carrier.",
    criteria:{ shoot:"dist 21 xg 7 angle 18 blockers 2", pass_h10:"dist 12 progress 2 lane 3.4 space 5 success 87 eta 0.9 opp_eta 2", press:"on h9 eta 0.6 rank 1 dist 3 danger 60", … } } } }
```
Rules: whole metres (one decimal only for times and for lane/pressure/keeper_off/offside_margin/height below 10), probabilities as
percent, booleans as a bare word when true, `opp_eta`/`mate_eta` omitted when nobody gets there (≥ 9 s), features that repeat
the player's own line or cannot decide (`offside_margin` on passes, `pressure` on shoot/clear/hold) dropped, an explicit `on <id>`
only when the option id does not already name its target. Never sent: `path`, `label`, `local`, velocities, batch ids.
Live A/B on identical situations (choice regret against the local utility): old format 0.15, this format 0.13, this format without
the playbook 0.28 — the playbook is what makes Jev play football, the players table did not change off-ball choices.

## `/api/decide` (server/jev.js)

Request: `{ shared, decisions: DecisionState[], request_id? }` (1–12 decisions, body ≤ 250 kB; no other top-level keys; `request_id`
`/^[a-zA-Z0-9-]{16,80}$/` is the hosted ledger's idempotency key and is ignored locally; server validates everything and builds
the Jev payload itself — the client can never send raw prompts).
Response 200:
```js
{ model, source:"jev", decisions:{ "<player_id>": { batch_id, choice, probabilities, confidence, source:"jev"|"only_option" } },
  usage:{input_tokens,output_tokens}, latency_ms, request_bytes, cost_usd,
  pricing:{input_per_million,output_per_million}, request /* exact Jev payload, for the inspector */ }
```
Errors: `{ error }` with status 400/403/413/429/502/503 (503 = no key configured).
`GET /api/status` → `{ configured:boolean, model:"jev-latest", pricing }`.

Exports for the hosted worker: `validBatch(body)`, `prepare(body)` → `{ prepared, payload, bytes }` (throws 400),
`evaluate(body, env, signal?, onUsage?, prebuilt?)` — `onUsage({input_tokens,output_tokens})` is awaited as soon as Jev's usage is
known and before answers are validated (zero usage when nothing had to be asked); thrown errors carry `status` and `billable`
(`false` = Jev certainly did not charge: upstream 4xx and bad requests; `true` for 5xx/incomplete answers; unset for network errors and timeouts).

## `DecisionLoop` (src/decision-loop.js)

```js
const loop = new DecisionLoop(sim, { fetch, endpoint:"/api/decide", maxBatch:12, maxInFlight:2, tickMs:250, rules:TRIAGE });
loop.configured = true|false;   // from /api/status; when false every due player uses sim.decideLocally
loop.enabled = true;
loop.tick(performance.now());   // call every frame; internally rate-limited
loop.tally   // { calls, decisions, jevDecisions, localDecisions, triaged, kept, held, stale, cost, input, output, request_bytes, latencies:[], errors }
loop.last    // { request, response, at } for the inspector
loop.onBatch = (info) => {}; loop.onError = (message) => {};
// hosted mode (docs/AUTH.md)
loop.credits; loop.onCredits = (credits) => {}; loop.onAuthRequired = () => {}; loop.onCreditExhausted = (credits) => {};
loop.held   // null | "auth" | "credit" | "cap"; loop.resume() clears it
```
On 429/5xx: exponential backoff, players fall back to local. Marks `player.pending`. Every POST carries a fresh `request_id`.
`401 {auth_required}`, `402 {code:"credit_exhausted"}` and `503 {code:"daily_cap"}` hold the loop: all decisions local, no
requests, no backoff, callback fired once, until `resume()`.

Cost controls (constants in `TRIAGE`, scheduling in the pure `planBatch(sim, due, { now, waiting, canSend, maxBatch, rules })`,
which `scripts/verify-jev.mjs` reuses so the live measurement bills what the browser would):
- **Always Jev, immediately**: the carrier, the restart taker, and anyone within 8 m of a truly loose ball; they take every other due player along.
- **Triage** (source `"local"`, `tally.triaged`): off-ball players > 28 m from the ball whose options are all positional
  (`shape`/`cover`/`support`) or whose local policy is ≥ 0.8 sure, and every off-ball player > 42 m away.
- **Standing choice** (source stays `"jev"`, `tally.kept`): an off-ball player > 15 m from the ball re-applies Jev's last choice to the
  freshly computed options (new targets) without asking, for ≤ 2.5 sim-s, only if Jev gave it ≥ 0.5 and nothing changed (same kind,
  same option ids, same local-policy reading as when Jev was asked). Within 15 m every decision is a fresh Jev call.
- **Fuller calls**: a batch without an urgent player waits until it has 4 questions or its oldest player has waited 500 ms.
Sim cadence is unchanged (carrier 0.30 s, near 0.55 s, others 1.2 s).

## `MatchScene` (src/scene.js)

```js
const scene = new MatchScene(canvas, sim, labelsEl);
await scene.ready;
scene.cameraNames  // ["Broadcast","Tactical","Follow","Behind goal"]
scene.setCamera(name); scene.nextCamera() → name
scene.setCandidatesVisible(bool);
scene.setFocus(playerId|null);      // whose candidates to draw; null = ball carrier / most recent decider near ball
scene.update(dt, nowSeconds);       // render one frame, reads sim directly
scene.resize(); scene.dispose();
```

## Look and feel

The visual identity is "Matchday broadcast" — dark green-black ink panels, chalk text, a floodlight-yellow
accent, Barlow Condensed — and is specified in [`docs/THEME.md`](THEME.md); tokens live in `src/theme.css`.
The 3D scene itself stays bright daylight: `ACESFilmicToneMapping`, sRGB output, PCF soft shadows from one
warm sun + hemisphere fill, HDR sky `public/textures/daylight.hdr` as environment and background, PBR grass
and pavement from `public/textures/` (metric UVs). Candidate arrows, probability chips (`.vector-label`) and
every HUD surface take their colours from the theme. Lucide icons. Brand mark: `public/brand/jevball-mark.svg`.
