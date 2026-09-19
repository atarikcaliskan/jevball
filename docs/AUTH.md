# Hosted mode: sign-in and play credit

Locally (`npm run dev` / `npm run preview`) JevBall has **no login**: the Vite middleware proxies Jev with
your own `TYPESAFE_API_KEY` and `/api/status` says `auth_required: false`.

The hosted deployment is a **Cloudflare Worker** (router `server/worker.js`, deployable entry `server/entry.js`) serving the built site from `dist/`
and owning every `/api/*` route. The site stays public — landing page, and the match on the local policy —
and **only Jev spending is gated**: `/api/decide` needs a signed-in user with play credit.

## Principles

- Security never depends on hidden code: the Jev key and OAuth/session secrets are Worker secrets; the server
  validates every batch (`validBatch`) and builds the Jev prompt itself; the client can never send raw prompts.
- Sessions are stateless HMAC-signed cookies; accounts and balances live in one Durable Object per user.
- Money is integer **nanodollars** (1 USD = 1e9). Reserve a worst-case charge before the upstream call,
  settle to Jev's reported usage afterwards, never refund a call whose outcome is unknown.

## Routes (Worker)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/status` | public | see below |
| `POST /api/auth/:provider/start` | public, rate-limited per IP | `{ url }` to redirect the browser to; sets the state cookie. `:provider` = `github` \| `google` |
| `GET /api/auth/:provider/callback` | state cookie | verifies state, exchanges the code server-to-server, creates/loads the account, sets the session cookie, `303 → /play.html?auth=ok` (or `/play.html?auth=error`); the state cookie is always cleared |
| `POST /api/auth/logout` | session | clears the cookie |
| `POST /api/admin/topup` | `Authorization: Bearer $ADMIN_TOKEN` | owner-only manual credit `{ user_id, amount_usd (≤ 100), order_id }` → `topUp`; the route is a 404 unless the optional `ADMIN_TOKEN` secret (≥ 32 chars) is set, and it never creates accounts |
| `POST /api/decide` | **session + credit** | `{ shared, decisions, request_id }` → same response as local mode **plus `credits`** |
| everything else | public | static assets (`env.ASSETS`) |

All `POST`s require `Origin === APP_ORIGIN` and `Content-Type: application/json` (403 otherwise). Bodies are capped (250 kB).
Every response gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; API responses `Cache-Control: no-store`.

### `GET /api/status`

```js
// local dev
{ auth_required:false, authenticated:false, configured, model, pricing }
// hosted
{ auth_required:true, authenticated:boolean, providers:["github","google"],   // only providers with configured secrets
  user: { id, name, avatar_url, provider } | null,
  credits: Credits | null,
  grant_usd,                                   // what a new account receives (PLAY_GRANT_USD)
  configured, model, pricing }
Credits = { granted_usd, purchased_usd, remaining_usd, spent_usd, exhausted:boolean }
```

### `/api/decide` errors (hosted)

`401 { error, auth_required:true }` not signed in · `402 { error, code:"credit_exhausted", credits }` ·
`429` too many requests for this account (or upstream rate limit) · `503 { error, code:"daily_cap" }` global spend cap reached ·
400/403/413/502 as in local mode. The client falls back to the local policy in every case; play never stops.

## Identity

- **GitHub**: authorization-code flow, scope `read:user`; stable id = numeric `id` → user id `gh_<id>`. The access token is discarded after reading `/user`.
- **Google**: OpenID Connect, scope `openid email profile`, PKCE (S256) + `nonce`; the ID token arrives straight from Google's token endpoint over TLS, so claims are checked (`iss`, `aud`, `exp`, `nonce`, `email_verified`) without a JWKS round trip; stable id = `sub` → `gg_<sub>`.
- State: `{ nonce, provider }` HMAC-signed, 10 min, stored in `__Host-jevball-oauth` and echoed as the OAuth `state` parameter; both must match, and `provider` must match the callback path. The PKCE verifier and the OIDC `nonce` never travel in the state (it is visible in URLs): they are derived server-side as `HMAC(SESSION_SECRET, "pkce:" + nonce)` / `HMAC(SESSION_SECRET, "oidc:" + nonce)`.
- Session: `__Host-jevball` = `base64url({ value:{ user_id }, exp })` + `.` + HMAC-SHA256, 30 days, `HttpOnly; Secure; SameSite=Lax; Path=/`. Rotating `SESSION_SECRET` signs everyone out and resets nothing else.
- Accounts are keyed by provider id, never by email. Email is not stored.

## Play account (`PlayAccount` Durable Object, one per user id)

Pure logic lives in `server/ledger.js` (Node-testable, storage injected); `server/account.js` is the thin Durable Object wrapper.

- One-time grant on first sign-in: `PLAY_GRANT_USD` (default 0.10 — about ten match-minutes at the measured ≈ $0.01 per match-minute).
- `decide({ shared, decisions, request_id })`:
  1. `request_id` (`/^[a-zA-Z0-9-]{16,80}$/`) — a repeated id returns the stored receipt (last 16 kept): retries never double-charge.
  2. At most **2 requests in flight** per account (the client's `maxInFlight`) and ≥ 100 ms between starts → else 429.
  3. Build the Jev payload; cap it (48 kB); **reserve** `ceil((bytes/2 + 2048) tokens × input price)` nanodollars — bytes/2 is a deliberately pessimistic token bound (measured ≈ bytes/2.4). Insufficient balance → 402.
  4. Ask the global `SpendGuard` for the same reservation → 503 `daily_cap` when the day's cap (`DAILY_CAP_USD`, default 5) would be exceeded.
  5. Persist the pending reservation, call Jev (10 s timeout), and on reported usage **settle**: refund `reserve − actual` to the account and the guard *before* validating answers.
  6. Upstream failure that is certainly unbilled (`error.billable === false`: 4xx from Jev) refunds fully and leaves no receipt, so the batch may be retried; timeouts/5xx/interruptions keep the reservation and store the error as the receipt (a retry of that id costs nothing more). A Durable Object restart converts any persisted pending reservation into a kept debit.
  - Upstream 401/402 (the operator's key or Jev balance) surface as a generic 502, never as the player's 401/402. If reported usage ever exceeds the reservation, the charge is capped at the available balance: a balance is never negative.
  - `credits.exhausted` is true when the balance no longer covers the largest request the server accepts (48 kB), so `exhausted:false` guarantees the next decide is not a 402.
- `topUp({ amount_nanodollars, order_id, source })` → `{ applied, credits }` — idempotent by `order_id`; tracked separately as `purchased`. Today it is reached through `POST /api/admin/topup`.
- `reverseTopUp({ order_id, amount_nanodollars })` → `{ removed_nanodollars, shortfall_nanodollars, credits }` — undoes a previous `topUp` once per order: removes at most the unspent balance, records the rest as `refund_shortfall`.
- `snapshot()` → `{ user, credits }`.

`SpendGuard` (singleton Durable Object): per-UTC-day reserved/spent counter with `reserve(n)` / `settle(reserved, actual)`.

## Configuration

`wrangler.jsonc` vars: `APP_ORIGIN`, `JEV_INPUT_PRICE`, `JEV_OUTPUT_PRICE` (must stay 0 until output is bounded), `PLAY_GRANT_USD`, `DAILY_CAP_USD`.
Secrets (`npx wrangler secret put NAME`): `TYPESAFE_API_KEY`, `SESSION_SECRET` (≥ 32 random characters; anything shorter fails closed), optional `ADMIN_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. A provider is offered only when both of its values are set.
Bindings: `ASSETS`, Durable Objects `PLAY_ACCOUNTS` (`PlayAccount`), `SPEND_GUARD` (`SpendGuard`), rate limiter `AUTH_LIMITER` (20/min per IP).

## Client

`DecisionLoop` sends a fresh `request_id` per POST (re-used when retrying the same batch) and exposes
`onAuthRequired()`, `onCreditExhausted(credits)`, `onCredits(credits)`; `loop.credits` holds the latest balance.
401/402/503-`daily_cap` switch the loop to the local policy without backoff spirals until `loop.resume()` is called
(after sign-in or top-up). The HUD (`src/hud-auth.js`) shows **Sign in** (GitHub / Google) when
`auth_required && !authenticated`, the remaining credit next to the session cost when signed in, and a sign-out action.
