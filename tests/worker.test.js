import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../server/worker.js";
import { Ledger } from "../server/ledger.js";
import { sign, derive, pkceChallenge, toBase64Url } from "../server/auth.js";

const ORIGIN = "https://jevball.test";
const SECRET = "test-only-session-secret-0123456789abcdef";
console.error = () => {}; // failure paths log on purpose

class MemoryStorage {
  data = new Map();
  async get(key) {
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key) {
    this.data.delete(key);
  }
}

function makeEnv(over = {}) {
  const accounts = new Map(),
    log = { initialize: 0, decide: 0, assets: 0, limited: [] };
  const env = {
    APP_ORIGIN: ORIGIN,
    SESSION_SECRET: SECRET,
    TYPESAFE_API_KEY: "test-only-key",
    JEV_INPUT_PRICE: "0.042",
    JEV_OUTPUT_PRICE: "0",
    PLAY_GRANT_USD: "0.10",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    GOOGLE_CLIENT_ID: "gg-client",
    GOOGLE_CLIENT_SECRET: "gg-secret",
    ASSETS: {
      fetch: async (request) => {
        log.assets++;
        return new Response(`asset ${new URL(request.url).pathname}`, {
          headers: { "Content-Type": "text/html" },
        });
      },
    },
    AUTH_LIMITER: {
      limit: async ({ key }) => {
        log.limited.push(key);
        return { success: key !== "203.0.113.9" };
      },
    },
    PLAY_ACCOUNTS: {
      idFromName: (name) => name,
      get(name) {
        if (!accounts.has(name)) {
          const ledger = new Ledger({
            storage: new MemoryStorage(),
            env,
            prepare: (body) => {
              if (!body.shared)
                throw Object.assign(new Error("bad"), { status: 400 });
              return {
                prepared: { request: { questions: { h9: {} } } },
                payload: "{}",
                bytes: 3000,
              };
            },
            evaluate: async (_b, _e, _s, onUsage) => {
              await onUsage({ input_tokens: 1000, output_tokens: 0 });
              return {
                source: "jev",
                decisions: {},
                invalid: [],
                usage: { input_tokens: 1000, output_tokens: 0 },
              };
            },
            guard: { reserve: async () => true, settle: async () => {} },
          });
          const ready = ledger.load();
          accounts.set(name, {
            initialize: async (identity) => (
              await ready,
              log.initialize++,
              ledger.initialize(identity)
            ),
            snapshot: async () => (await ready, ledger.snapshot()),
            decide: async (body) => (
              await ready,
              log.decide++,
              ledger.decide(body)
            ),
            topUp: async (order) => (await ready, ledger.topUp(order)),
          });
        }
        return accounts.get(name);
      },
    },
    ...over,
  };
  return { env, log };
}

const call = (env, path, init = {}) =>
  handle(
    new Request(path.startsWith("http") ? path : ORIGIN + path, {
      redirect: "manual",
      ...init,
    }),
    env,
  );
const post = (env, path, body = {}, headers = {}) =>
  call(env, path, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const cookiesOf = (response) => response.headers.getSetCookie();
const sessionCookie = async (userId, seconds = 60) =>
  `__Host-jevball=${await sign(SECRET, { user_id: userId }, seconds)}`;

async function withFetch(routes, run) {
  const original = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (!routes[String(url)]) throw new Error(`unexpected fetch ${url}`);
    return routes[String(url)]();
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
const GITHUB = {
  "https://github.com/login/oauth/access_token": () =>
    Response.json({ access_token: "gho_x" }),
  "https://api.github.com/user": () =>
    Response.json({
      id: 7,
      login: "ada",
      avatar_url: "https://avatars.githubusercontent.com/u/7",
    }),
};

// start → the state cookie and the provider URL, as a browser would hold them
async function begin(env, provider = "github") {
  const response = await post(env, `/api/auth/${provider}/start`);
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  const [setCookie] = cookiesOf(response);
  return {
    url,
    state: url.searchParams.get("state"),
    cookie: setCookie.split(";")[0],
    setCookie,
  };
}

function assertHeaders(response, api) {
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  if (api) assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("status: signed out, signed in, stale session — never 401", async () => {
  const { env } = makeEnv();
  const out = await call(env, "/api/status");
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), {
    auth_required: true,
    authenticated: false,
    providers: ["github", "google"],
    user: null,
    credits: null,
    grant_usd: 0.1,
    configured: true,
    model: "jev-latest",
    pricing: { input_per_million: 0.042, output_per_million: 0 },
  });
  assert.deepEqual(cookiesOf(out), []);

  await env.PLAY_ACCOUNTS.get("gh_7").initialize({
    id: "gh_7",
    name: "Ada",
    avatar_url: null,
    provider: "github",
  });
  const signedIn = await call(env, "/api/status", {
    headers: { Cookie: await sessionCookie("gh_7") },
  });
  const body = await signedIn.json();
  assert.equal(body.authenticated, true);
  assert.deepEqual(body.user, {
    id: "gh_7",
    name: "Ada",
    avatar_url: null,
    provider: "github",
  });
  assert.deepEqual(body.credits, {
    granted_usd: 0.1,
    purchased_usd: 0,
    remaining_usd: 0.1,
    available_usd: 0.1,
    spent_usd: 0,
    exhausted: false,
  });

  // a valid signature for an account that was never created
  const stale = await call(env, "/api/status", {
    headers: { Cookie: await sessionCookie("gh_999") },
  });
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).authenticated, false);
  assert.match(cookiesOf(stale)[0], /^__Host-jevball=; .*Max-Age=0/);

  for (const Cookie of [
    "__Host-jevball=garbage",
    await sessionCookie("gh_7", -1),
  ]) {
    const bad = await call(env, "/api/status", { headers: { Cookie } });
    assert.equal(bad.status, 200);
    assert.equal((await bad.json()).authenticated, false);
  }
  const { env: bare } = makeEnv({
    GOOGLE_CLIENT_SECRET: undefined,
    TYPESAFE_API_KEY: undefined,
    SESSION_SECRET: undefined,
  });
  const partial = await (
    await call(bare, "/api/status", {
      headers: { Cookie: await sessionCookie("gh_7") },
    })
  ).json();
  assert.deepEqual(partial.providers, ["github"]);
  assert.equal(partial.configured, false);
  assert.equal(partial.authenticated, false);
  assert.equal((await post(env, "/api/status")).status, 405);
});

test("start: 404s, rate limit, state cookie, Google URL with state + PKCE + nonce", async () => {
  const { env, log } = makeEnv();
  assert.equal((await post(env, "/api/auth/gitlab/start")).status, 404);
  const { env: noGoogle } = makeEnv({ GOOGLE_CLIENT_ID: "" });
  assert.equal((await post(noGoogle, "/api/auth/google/start")).status, 404);
  const limited = await post(
    env,
    "/api/auth/github/start",
    {},
    { "CF-Connecting-IP": "203.0.113.9" },
  );
  assert.equal(limited.status, 429);
  assert.deepEqual(cookiesOf(limited), []);
  assert.equal(log.limited.at(-1), "203.0.113.9");
  assert.equal((await call(env, "/api/auth/github/start")).status, 405);
  assert.equal(
    (
      await post(
        env,
        "/api/auth/github/start",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const { env: noSecret } = makeEnv({ SESSION_SECRET: undefined });
  const closed = await post(noSecret, "/api/auth/github/start");
  assert.equal(closed.status, 503);
  assert.deepEqual(cookiesOf(closed), []);
  const { env: noLimiter } = makeEnv({ AUTH_LIMITER: undefined });
  assert.equal((await post(noLimiter, "/api/auth/github/start")).status, 200);

  const github = await begin(env, "github");
  assert.match(
    github.setCookie,
    /^__Host-jevball-oauth=[\w.-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
  );
  assert.equal(github.cookie, `__Host-jevball-oauth=${github.state}`);
  assert.equal(
    github.url.searchParams.get("redirect_uri"),
    `${ORIGIN}/api/auth/github/callback`,
  );

  const google = await begin(env, "google");
  assert.equal(google.url.hostname, "accounts.google.com");
  const payload = JSON.parse(
    Buffer.from(google.state.split(".")[0], "base64url"),
  );
  assert.equal(payload.value.provider, "google");
  assert.deepEqual(Object.keys(payload.value).sort(), ["nonce", "provider"]); // no verifier in the URL
  assert.equal(
    google.url.searchParams.get("code_challenge"),
    await pkceChallenge(await derive(SECRET, `pkce:${payload.value.nonce}`)),
  );
  assert.equal(google.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    google.url.searchParams.get("nonce"),
    await derive(SECRET, `oidc:${payload.value.nonce}`),
  );
  assert.notEqual(google.state, (await begin(env, "google")).state);
});

test("callback: every state failure → /play.html?auth=error with the state cookie cleared", async () => {
  const { env, log } = makeEnv();
  await withFetch({}, async (calls) => {
    const good = await begin(env, "github");
    const other = await begin(env, "github");
    const google = await begin(env, "google");
    const expired = await sign(SECRET, { nonce: "n", provider: "github" }, -1);
    const forged = await sign(
      "another-secret-another-secret-another",
      { nonce: "n", provider: "github" },
      600,
    );
    const cases = {
      "state mismatch": [`code=c&state=${other.state}`, good.cookie],
      "no cookie": [`code=c&state=${good.state}`, ""],
      "no state": ["code=c", good.cookie],
      "no code": [`state=${good.state}`, good.cookie],
      "provider error": [
        `error=access_denied&state=${good.state}`,
        good.cookie,
      ],
      "wrong provider in state": [
        `code=c&state=${google.state}`,
        google.cookie,
      ],
      expired: [`code=c&state=${expired}`, `__Host-jevball-oauth=${expired}`],
      forged: [`code=c&state=${forged}`, `__Host-jevball-oauth=${forged}`],
    };
    for (const [name, [query, Cookie]] of Object.entries(cases)) {
      const response = await call(env, `/api/auth/github/callback?${query}`, {
        headers: { Cookie },
      });
      assert.equal(response.status, 303, name);
      assert.equal(
        response.headers.get("Location"),
        "/play.html?auth=error",
        name,
      );
      const cookies = cookiesOf(response);
      assert.equal(cookies.length, 1, name);
      assert.match(cookies[0], /^__Host-jevball-oauth=; .*Max-Age=0$/, name);
      assertHeaders(response, true);
    }
    assert.equal(calls.length, 0); // no code was ever exchanged
    assert.equal(log.initialize, 0);
  });
  // the exchange itself fails upstream
  await withFetch(
    {
      "https://github.com/login/oauth/access_token": () =>
        new Response("no", { status: 500 }),
    },
    async () => {
      const good = await begin(env, "github");
      const response = await call(
        env,
        `/api/auth/github/callback?code=c&state=${good.state}`,
        { headers: { Cookie: good.cookie } },
      );
      assert.equal(response.headers.get("Location"), "/play.html?auth=error");
      assert.ok(
        !cookiesOf(response).some((c) => c.startsWith("__Host-jevball=")),
      );
    },
  );
});

test("callback success: session cookie, state cleared, account granted once", async () => {
  const { env, log } = makeEnv();
  await withFetch(GITHUB, async (calls) => {
    let session;
    for (let round = 0; round < 2; round++) {
      const flow = await begin(env, "github");
      const response = await call(
        env,
        `/api/auth/github/callback?code=the-code&state=${flow.state}`,
        { headers: { Cookie: flow.cookie } },
      );
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("Location"), "/play.html?auth=ok");
      const cookies = cookiesOf(response);
      assert.ok(
        cookies.some((c) => /^__Host-jevball-oauth=; .*Max-Age=0$/.test(c)),
      );
      session = cookies.find((c) => c.startsWith("__Host-jevball="));
      assert.match(
        session,
        /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/,
      );
    }
    assert.equal(
      new URLSearchParams(calls[0].body).get("redirect_uri"),
      `${ORIGIN}/api/auth/github/callback`,
    );
    assert.equal(log.initialize, 2);
    const status = await (
      await call(env, "/api/status", {
        headers: { Cookie: session.split(";")[0] },
      })
    ).json();
    assert.equal(status.authenticated, true);
    assert.deepEqual(status.user, {
      id: "gh_7",
      name: "ada",
      avatar_url: "https://avatars.githubusercontent.com/u/7",
      provider: "github",
    });
    assert.equal(status.credits.granted_usd, 0.1); // two sign-ins, one grant
  });
});

test("Google callback sends the derived PKCE verifier and checks the derived nonce", async () => {
  const { env } = makeEnv();
  const flow = await begin(env, "google");
  const nonce = flow.url.searchParams.get("nonce");
  const encode = (v) =>
    toBase64Url(new TextEncoder().encode(JSON.stringify(v)));
  const claims = {
    iss: "https://accounts.google.com",
    aud: "gg-client",
    exp: Date.now() / 1000 + 600,
    nonce,
    email_verified: true,
    sub: "1234567890",
    name: "Grace",
  };
  await withFetch(
    {
      "https://oauth2.googleapis.com/token": () =>
        Response.json({ id_token: `${encode({})}.${encode(claims)}.sig` }),
    },
    async (calls) => {
      const response = await call(
        env,
        `/api/auth/google/callback?code=c&state=${flow.state}`,
        { headers: { Cookie: flow.cookie } },
      );
      assert.equal(response.headers.get("Location"), "/play.html?auth=ok");
      const verifier = new URLSearchParams(calls[0].body).get("code_verifier");
      assert.equal(
        await pkceChallenge(verifier),
        flow.url.searchParams.get("code_challenge"),
      );
      assert.ok(!flow.state.includes(verifier));
    },
  );
});

test("logout clears the session cookie", async () => {
  const { env } = makeEnv();
  const response = await post(
    env,
    "/api/auth/logout",
    {},
    { Cookie: await sessionCookie("gh_7") },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(cookiesOf(response)[0], /^__Host-jevball=; .*Max-Age=0$/);
  assert.equal(
    (
      await post(
        env,
        "/api/auth/logout",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
});

test("decide gate: 403 cross-origin, 401 before the body is read, 413, 400, then the ledger", async () => {
  const { env, log } = makeEnv();
  const Cookie = await sessionCookie("gh_7");
  for (const headers of [
    { Origin: "https://evil.example" },
    { Origin: "null" },
    { "Content-Type": "text/plain" },
    { "Content-Type": "application/x-www-form-urlencoded" },
  ])
    assert.equal(
      (await post(env, "/api/decide", {}, { Cookie, ...headers })).status,
      403,
    );
  const noOrigin = await call(env, "/api/decide", {
    method: "POST",
    headers: { Cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noOrigin.status, 403);

  let pulled = 0;
  const unread = new ReadableStream(
    {
      pull() {
        pulled++;
        throw new Error("the body must not be read");
      },
    },
    { highWaterMark: 0 },
  );
  const anonymous = await call(env, "/api/decide", {
    method: "POST",
    duplex: "half",
    body: unread,
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      Cookie: "__Host-jevball=forged.token",
    },
  });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {
    error: "Sign in to play with Jev.",
    auth_required: true,
  });
  assert.equal(pulled, 0);
  const { env: noSecret } = makeEnv({ SESSION_SECRET: "" });
  assert.equal(
    (await post(noSecret, "/api/decide", {}, { Cookie })).status,
    401,
  );

  assert.equal(
    (await post(env, "/api/decide", "x".repeat(250_001), { Cookie })).status,
    413,
  );
  let sent = 0;
  const endless = new ReadableStream({
    pull(c) {
      sent++ > 100 ? c.close() : c.enqueue(new Uint8Array(10_000));
    },
  });
  const streamed = await call(env, "/api/decide", {
    method: "POST",
    duplex: "half",
    body: endless,
    headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie },
  });
  assert.equal(streamed.status, 413);
  assert.ok(sent < 40, "stopped reading at the cap");
  assert.equal(
    (await post(env, "/api/decide", "{not json", { Cookie })).status,
    400,
  );
  assert.equal(log.decide, 0);

  // signed session, but the account never signed in → the ledger's own 401
  assert.equal(
    (
      await post(
        env,
        "/api/decide",
        { shared: {}, request_id: "request-0000000000-1" },
        { Cookie },
      )
    ).status,
    401,
  );
  await env.PLAY_ACCOUNTS.get("gh_7").initialize({
    id: "gh_7",
    name: "Ada",
    avatar_url: null,
    provider: "github",
  });
  const ok = await post(
    env,
    "/api/decide",
    { shared: {}, request_id: "request-0000000000-2" },
    { Cookie, "Content-Type": "application/json; charset=utf-8" },
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.source, "jev");
  assert.equal(body.credits.spent_usd, 0.000042);
  assertHeaders(ok, true);
  assert.equal((await call(env, "/api/decide")).status, 405);
});

test("402 passes through with code and credits", async () => {
  const { env } = makeEnv({ PLAY_GRANT_USD: "0.0001" });
  await env.PLAY_ACCOUNTS.get("gh_7").initialize({
    id: "gh_7",
    name: "Ada",
    avatar_url: null,
    provider: "github",
  });
  const response = await post(
    env,
    "/api/decide",
    { shared: {}, request_id: "request-0000000000-1" },
    { Cookie: await sessionCookie("gh_7") },
  );
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.code, "credit_exhausted");
  assert.equal(body.credits.exhausted, true);
});

test("manual top-up: absent without ADMIN_TOKEN, bearer-gated, idempotent", async () => {
  const token = "admin-token-admin-token-admin-token-0123";
  const order = { user_id: "gh_7", amount_usd: 1.5, order_id: "manual-1" };
  const { env: off } = makeEnv();
  assert.equal(
    (
      await post(off, "/api/admin/topup", order, {
        Authorization: `Bearer ${token}`,
      })
    ).status,
    404,
  );
  const { env: weak } = makeEnv({ ADMIN_TOKEN: "short" });
  assert.equal(
    (
      await post(weak, "/api/admin/topup", order, {
        Authorization: "Bearer short",
      })
    ).status,
    404,
  );
  const { env } = makeEnv({ ADMIN_TOKEN: token });
  for (const Authorization of [
    undefined,
    "Bearer wrong",
    `Basic ${token}`,
    `Bearer ${token}x`,
  ])
    assert.equal(
      (
        await post(
          env,
          "/api/admin/topup",
          order,
          Authorization ? { Authorization } : {},
        )
      ).status,
      401,
    );
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await post(env, "/api/admin/topup", order, auth)).status, 404); // never signed in
  await env.PLAY_ACCOUNTS.get("gh_7").initialize({
    id: "gh_7",
    name: "Ada",
    avatar_url: null,
    provider: "github",
  });
  for (const bad of [
    { ...order, amount_usd: 0 },
    { ...order, amount_usd: 101 },
    { ...order, amount_usd: "x" },
    { ...order, user_id: "root" },
    { ...order, order_id: 7 },
    { ...order, order_id: "bad id" },
  ])
    assert.equal((await post(env, "/api/admin/topup", bad, auth)).status, 400);
  const first = await (await post(env, "/api/admin/topup", order, auth)).json();
  assert.equal(first.applied, true);
  assert.equal(first.credits.purchased_usd, 1.5);
  const second = await (
    await post(env, "/api/admin/topup", order, auth)
  ).json();
  assert.equal(second.applied, false);
  assert.equal(second.credits.remaining_usd, 1.6);
});

test("static assets are public; every response carries the security headers", async () => {
  const { env, log } = makeEnv();
  for (const path of ["/", "/play.html", "/assets/main.js"]) {
    const response = await call(env, path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `asset ${path}`);
    assertHeaders(response, false);
    assert.equal(response.headers.get("Cache-Control"), null);
  }
  assert.equal(log.assets, 3);
  for (const path of [
    "/api",
    "/api/nope",
    "/api/billing/checkout",
    "/api/auth/github",
    "/api/auth/github/callback/x",
  ]) {
    const response = await call(env, path);
    assert.equal(response.status, 404, path);
    assertHeaders(response, true);
  }
  assert.equal(log.assets, 3);
  // an unexpected failure is a plain 503 with headers, not a stack trace
  const { env: broken } = makeEnv({
    PLAY_ACCOUNTS: {
      idFromName: (n) => n,
      get: () => ({
        decide: async () => {
          throw new Error("secret detail");
        },
      }),
    },
  });
  const failed = await post(
    broken,
    "/api/decide",
    { a: 1 },
    { Cookie: await sessionCookie("gh_7") },
  );
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("secret detail"));
  assertHeaders(failed, true);
});

test("origin canonicalization: foreign hosts 308 to APP_ORIGIN; localhost works for wrangler dev", async () => {
  const { env, log } = makeEnv();
  const moved = await call(
    env,
    "https://jevball.workers.example/api/status?x=1",
  );
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get("Location"), `${ORIGIN}/api/status?x=1`);
  assertHeaders(moved, true);
  assert.equal(
    (await call(env, "http://localhost:8787/api/status")).status,
    308,
  );
  assert.equal(
    (await call(env, "https://jevball.workers.example/play.html")).status,
    308,
  );
  assert.equal(log.assets, 0);

  const { env: local } = makeEnv({ APP_ORIGIN: "http://localhost:8787" });
  assert.equal(
    (await call(local, "http://127.0.0.1:8787/api/status")).status,
    200,
  );
  assert.equal(
    (await call(local, "https://evil.example/api/status")).status,
    308,
  );
  const started = await handle(
    new Request("http://127.0.0.1:8787/api/auth/github/start", {
      method: "POST",
      body: "{}",
      headers: {
        Origin: "http://127.0.0.1:8787",
        "Content-Type": "application/json",
      },
    }),
    local,
  );
  assert.equal(started.status, 200);
  assert.equal(
    new URL((await started.json()).url).searchParams.get("redirect_uri"),
    "http://127.0.0.1:8787/api/auth/github/callback",
  );
  const crossed = await handle(
    new Request("http://127.0.0.1:8787/api/auth/github/start", {
      method: "POST",
      body: "{}",
      headers: {
        Origin: "http://localhost:8787",
        "Content-Type": "application/json",
      },
    }),
    local,
  );
  assert.equal(crossed.status, 403);

  const { env: unset } = makeEnv({ APP_ORIGIN: undefined });
  assert.equal((await call(unset, "/api/status")).status, 503);
  assert.equal((await call(unset, "/play.html")).status, 200);
});
