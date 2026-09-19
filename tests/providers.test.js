import test from "node:test";
import assert from "node:assert/strict";
import { toBase64Url } from "../server/auth.js";
import {
  providers,
  authorizeUrl,
  exchange,
  cleanName,
  cleanAvatar,
} from "../server/providers.js";

const ENV = {
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-secret-value",
  GOOGLE_CLIENT_ID: "gg-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gg-secret-value",
};
const REDIRECT = "https://jevball.test/api/auth/google/callback";
const encode = (value) =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
const idToken = (claims) =>
  `${encode({ alg: "RS256" })}.${encode(claims)}.c2ln`;
const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Replaces fetch and silences the (intentional) failure logs.
async function mocked(routes, run) {
  const original = globalThis.fetch,
    log = console.error,
    calls = [],
    logged = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return typeof route === "function" ? route(options) : route;
  };
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return await run(calls, logged);
  } finally {
    globalThis.fetch = original;
    console.error = log;
  }
}

const claims = (over = {}) => ({
  iss: "https://accounts.google.com",
  aud: ENV.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce: "nonce-1",
  email_verified: true,
  email: "someone@example.com",
  sub: "109876543210123456789",
  name: "Ada Player",
  picture: "https://lh3.googleusercontent.com/a/photo=s96-c",
  ...over,
});
const googleExchange = (tokenResponse) =>
  mocked(
    { "https://oauth2.googleapis.com/token": tokenResponse },
    (calls, logged) =>
      exchange("google", ENV, {
        code: "auth-code-1",
        redirectUri: REDIRECT,
        pkceVerifier: "verifier-1",
        nonce: "nonce-1",
      }).then((identity) => ({ identity, calls, logged })),
  );

test("only providers with both values configured are offered", () => {
  assert.deepEqual(providers(ENV), ["github", "google"]);
  assert.deepEqual(providers({ ...ENV, GOOGLE_CLIENT_SECRET: "" }), ["github"]);
  assert.deepEqual(providers({ GITHUB_CLIENT_ID: "x" }), []);
  assert.throws(() => authorizeUrl("google", {}, {}));
  assert.throws(() => authorizeUrl("gitlab", ENV, {}));
});

test("authorize URLs carry state, scope and (Google) PKCE + nonce", () => {
  const github = new URL(
    authorizeUrl("github", ENV, {
      state: "st",
      redirectUri: "https://j.test/cb",
    }),
  );
  assert.equal(
    github.origin + github.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(github.searchParams.get("client_id"), "gh-client");
  assert.equal(github.searchParams.get("scope"), "read:user");
  assert.equal(github.searchParams.get("state"), "st");
  assert.equal(github.searchParams.get("redirect_uri"), "https://j.test/cb");
  const google = new URL(
    authorizeUrl("google", ENV, {
      state: "st",
      redirectUri: REDIRECT,
      pkceChallenge: "challenge",
      nonce: "nonce-1",
    }),
  );
  assert.equal(
    google.origin + google.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(google.searchParams.get("response_type"), "code");
  assert.equal(google.searchParams.get("scope"), "openid email profile");
  assert.equal(google.searchParams.get("code_challenge"), "challenge");
  assert.equal(google.searchParams.get("code_challenge_method"), "S256");
  assert.equal(google.searchParams.get("nonce"), "nonce-1");
  assert.ok(!google.href.includes("gg-secret-value"));
});

test("GitHub: code → token → /user → gh_<numeric id>", async () => {
  await mocked(
    {
      "https://github.com/login/oauth/access_token": reply(200, {
        access_token: "gho_secret_token",
        token_type: "bearer",
      }),
      "https://api.github.com/user": reply(200, {
        id: 583231,
        login: "octocat",
        name: "  The Octocat\u0007 ",
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
        email: "octocat@github.com",
      }),
    },
    async (calls) => {
      const identity = await exchange("github", ENV, {
        code: "abc",
        redirectUri: "https://j.test/api/auth/github/callback",
      });
      assert.deepEqual(identity, {
        id: "gh_583231",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
        provider: "github",
      });
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].headers.Accept, "application/json");
      const form = new URLSearchParams(calls[0].body);
      assert.equal(form.get("code"), "abc");
      assert.equal(form.get("client_secret"), "gh-secret-value");
      assert.equal(calls[1].headers.Authorization, "Bearer gho_secret_token");
      assert.equal(calls[1].headers["User-Agent"], "jevball");
      assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
    },
  );
});

test("GitHub failures are generic and never log the code or token", async () => {
  const cases = [
    { "https://github.com/login/oauth/access_token": reply(500, {}) },
    {
      "https://github.com/login/oauth/access_token": reply(200, {
        error: "bad_verification_code",
      }),
    },
    { "https://github.com/login/oauth/access_token": reply(200, {}) },
    {
      "https://github.com/login/oauth/access_token": reply(200, {
        access_token: "gho_secret_token",
      }),
      "https://api.github.com/user": reply(500, {}),
    },
    {
      "https://github.com/login/oauth/access_token": reply(200, {
        access_token: "gho_secret_token",
      }),
      "https://api.github.com/user": reply(200, { id: "583231", login: "x" }),
    },
    {
      "https://github.com/login/oauth/access_token": () =>
        Promise.reject(new TypeError("network")),
    },
  ];
  for (const routes of cases)
    await mocked(routes, async (_, logged) => {
      await assert.rejects(
        exchange("github", ENV, {
          code: "the-code-value",
          redirectUri: "https://j.test/cb",
        }),
        { message: "Sign-in failed. Please try again." },
      );
      assert.equal(logged.length, 1);
      assert.ok(
        !/the-code-value|gho_secret_token|gh-secret-value/.test(logged[0]),
      );
    });
});

test("Google: id_token claims → gg_<sub>, with PKCE verifier sent", async () => {
  const { identity, calls } = await googleExchange(
    reply(200, { id_token: idToken(claims()), access_token: "ya29.x" }),
  );
  assert.deepEqual(identity, {
    id: "gg_109876543210123456789",
    name: "Ada Player",
    avatar_url: "https://lh3.googleusercontent.com/a/photo=s96-c",
    provider: "google",
  });
  assert.ok(!("email" in identity));
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "verifier-1");
  assert.equal(form.get("redirect_uri"), REDIRECT);
  assert.equal(calls.length, 1);
  const bare = await googleExchange(
    reply(200, { id_token: idToken(claims({ iss: "accounts.google.com" })) }),
  );
  assert.equal(bare.identity.id, "gg_109876543210123456789");
});

test("Google: every bad claim and upstream failure is rejected", async () => {
  const bad = {
    aud: claims({ aud: "someone-else.apps.googleusercontent.com" }),
    iss: claims({ iss: "https://accounts.example.com" }),
    nonce: claims({ nonce: "other" }),
    "no nonce": claims({ nonce: undefined }),
    expired: claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
    unverified: claims({ email_verified: false }),
    "string verified": claims({ email_verified: "true" }),
    sub: claims({ sub: "../admin" }),
  };
  for (const [name, value] of Object.entries(bad))
    await assert.rejects(
      googleExchange(reply(200, { id_token: idToken(value) })),
      { message: "Sign-in failed. Please try again." },
      name,
    );
  for (const response of [
    reply(500, {}),
    reply(200, { error: "invalid_grant" }),
    reply(200, {}),
    reply(200, { id_token: "only.two" }),
    new Response("<html>", { status: 200 }),
  ])
    await assert.rejects(googleExchange(response));
  await assert.rejects(exchange("google", ENV, { code: "" }));
  await mocked({}, () =>
    assert.rejects(exchange("google", {}, { code: "x", nonce: "n" })),
  );
});

test("names and avatars are sanitized", async () => {
  assert.equal(cleanName("x".repeat(200)).length, 80);
  assert.equal(cleanName(""), "Player");
  assert.equal(cleanName(null), "Player");
  assert.equal(cleanName("A\nB"), "A B");
  assert.equal(cleanAvatar("http://avatars.githubusercontent.com/u/1"), null);
  assert.equal(cleanAvatar("https://evil.example/a.png"), null);
  assert.equal(
    cleanAvatar("https://googleusercontent.com.evil.example/a"),
    null,
  );
  assert.equal(
    cleanAvatar("https://user:pw@avatars.githubusercontent.com/u/1"),
    null,
  );
  assert.equal(cleanAvatar("javascript:alert(1)"), null);
  assert.equal(cleanAvatar(undefined), null);
  assert.equal(
    cleanAvatar("https://lh3.googleusercontent.com/a/x"),
    "https://lh3.googleusercontent.com/a/x",
  );
  const { identity } = await googleExchange(
    reply(200, {
      id_token: idToken(
        claims({ picture: "http://lh3.googleusercontent.com/a" }),
      ),
    }),
  );
  assert.equal(identity.avatar_url, null);
});
