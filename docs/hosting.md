# Hosting JevBall on Cloudflare Workers

`docs/AUTH.md` is the contract (routes, cookies, ledger rules). This page is the walkthrough.
The Worker serves the built site from `dist/` and owns `/api/*`. The site is public; only Jev spending
(`/api/decide`) needs a signed-in player with play credit. You need a Cloudflare account (Durable Objects
with SQLite storage work on the free plan), a TypeSafe AI key, and a GitHub and/or Google OAuth app.

The production deployment is `https://jevball.online`; if you host your own copy, substitute your origin throughout.

## 1. Choose the origin

Edit `wrangler.jsonc`:

- `vars.APP_ORIGIN`: scheme + host, no trailing slash. Requests arriving on any other origin are redirected
  (308) to it, `POST`s must carry it as `Origin`, and the OAuth callback URLs are built from it.
- Custom domain: uncomment `routes` with your hostname and `"workers_dev": false`. Without a custom domain,
  set `APP_ORIGIN` to the `https://jevball.<your-subdomain>.workers.dev` URL that `wrangler deploy` prints.
- `ratelimits[0].namespace_id` (`"1001"`) is a placeholder: any integer unique among your account's rate limiters.

## 2. Create the OAuth apps

A provider is offered on the sign-in panel only when both of its values are set; one provider is enough.

**GitHub** — Settings → Developer settings → OAuth Apps → New OAuth App.
Homepage `https://jevball.online`, Authorization callback URL
`https://jevball.online/api/auth/github/callback`. Generate a client secret.
JevBall asks for scope `read:user` only and throws the access token away after reading the profile.

**Google** — Google Cloud console → **Google Auth Platform** (the former "OAuth consent screen"):

1. *Get started* / **Branding**: app name, support email, home page `https://jevball.online`, authorized domain `jevball.online`.
2. **Audience**: user type **External**, then **Publish app** — while it is "Testing" only listed test users can sign in.
3. **Data Access**: scopes `openid`, `userinfo.email`, `userinfo.profile`. They are non-sensitive, so no verification review is needed.
4. **Clients** → *Create client* → **Web application**: Authorized JavaScript origin `https://jevball.online`,
   Authorized redirect URI `https://jevball.online/api/auth/google/callback`. Copy the client secret right away; it is shown once.

(The same client can still be created under APIs & Services → Credentials → Create credentials → OAuth client ID.)

## 3. Set the secrets

```sh
npx wrangler login                       # once
npx wrangler secret put TYPESAFE_API_KEY
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET   # ≥ 32 characters, or every sign-in fails closed
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

(`wrangler secret put` on a Worker that does not exist yet offers to create it; alternatively deploy first.)
Rotating `SESSION_SECRET` signs everyone out and changes nothing else.

## 4. Deploy

```sh
npm run deploy        # vite build → dist/, then wrangler deploy
```

Static files get their security headers from `public/_headers`; `/api/*` responses get them from the Worker.
Cloudflare serves `/play.html` as `/play` (a 307 that keeps the query string), which the game handles.

## 5. Money: grant, daily cap, pricing

All in `wrangler.jsonc` → `vars`, all plain USD strings; balances are kept as integer nanodollars.

| Var | Default | Meaning |
|---|---|---|
| `PLAY_GRANT_USD` | `0.10` | One-time free credit per new account (about ten match-minutes). Changing it affects only accounts created afterwards. |
| `DAILY_CAP_USD` | `5` | **Your maximum Jev bill per UTC day**, over all players together. When reached, `/api/decide` answers `503 daily_cap` and everyone plays on the local policy until midnight UTC. Set it to what you are willing to lose on a bad day — `1` is a sensible start. |
| `JEV_INPUT_PRICE` | `0.042` | USD per million input tokens; must match what TypeSafe bills you. |
| `JEV_OUTPUT_PRICE` | `0` | Must stay `0`. Output size is not bounded, so it cannot be reserved for; with any other value the Worker refuses to call Jev. |

Each call reserves `ceil((payload bytes / 2 + 2048) tokens × input price)` — deliberately pessimistic; a typical
3.5 kB batch reserves ≈ $0.00016 and settles to ≈ $0.00007 — and refunds the difference when Jev reports usage.
A call whose outcome is unknown (timeout, 5xx, restart) keeps its reservation.
The worst-case exposure is `DAILY_CAP_USD` per day, regardless of how many accounts are created.

### Topping up an account by hand

Payments are not part of this project. To credit a player (or yourself) manually, set an admin token once:

```sh
openssl rand -base64 48 | npx wrangler secret put ADMIN_TOKEN     # without it the route is a 404
```

and call the route; the player's id is shown by `GET /api/status` while signed in (`user.id`, e.g. `gh_583231`):

```sh
curl -X POST https://jevball.online/api/admin/topup \
  -H "Origin: https://jevball.online" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"user_id":"gh_583231","amount_usd":1,"order_id":"manual-2026-09-19-a"}'
```

`order_id` makes it idempotent: repeating the same id answers `applied:false` and credits nothing. At most $100
per call; accounts that never signed in are refused (404). Delete the secret (`npx wrangler secret delete ADMIN_TOKEN`)
to remove the route again. The ledger also has `reverseTopUp({ order_id, amount_nanodollars })`; it is not routed.

## 6. Local Worker (`wrangler dev`)

`npm run dev` needs none of this (no login, your own key). To exercise the hosted path locally:

```sh
cp .dev.vars.example .dev.vars      # fill it in; it is git-ignored
npm run dev:worker                  # http://localhost:8787
```

- `.dev.vars` must set `APP_ORIGIN=http://localhost:8787`; the Worker then also accepts `127.0.0.1`.
- The OAuth apps need a localhost callback: GitHub allows one callback per app, so create a second "JevBall dev"
  app with `http://localhost:8787/api/auth/github/callback`; on Google add
  `http://localhost:8787/api/auth/google/callback` as a second redirect URI.
- The cookies are `__Host-` + `Secure`. Chrome and Firefox accept them on `http://localhost`; Safari does not.
- Durable Object state lives in `.wrangler/` (git-ignored); delete it to reset all local accounts.

## 7. What is stored about a player

One Durable Object per player, keyed by the provider's stable id (`gh_<numeric id>` / `gg_<sub>`), holding:
provider + id, display name, avatar URL, granted/purchased/spent balances, top-up order ids, and the last 16
decision receipts (players' choices — no prompts). **No email, no provider tokens, no IP addresses.**
The session is a signed cookie with the user id and an expiry; there is no server-side session table.

## 8. Release checks

Run against the deployed origin (`O=https://jevball.online`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST $O/api/decide -H "Origin: $O" -H 'Content-Type: application/json' -d '{}'   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $O/api/decide -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}'   # 403
curl -s $O/api/status    # auth_required:true, authenticated:false, providers:[…], user:null, credits:null, configured:true
curl -sI $O/api/status   # nosniff, no-referrer, X-Frame-Options: DENY, Cache-Control: no-store
```

Then in a browser: sign in with each provider and land on the match with `credits.remaining_usd` = the grant;
sign out and in again — the balance is unchanged (no second grant); play until the credit is gone (or deploy a
test Worker with `PLAY_GRANT_USD` = `0.0001`) and see `/api/decide` answer `402 credit_exhausted` while the match
continues on the local policy; `npx wrangler tail` shows no secrets, codes or tokens in the logs.
