// Hosted JevBall: every /api/* route of the Cloudflare Worker. The site itself
// is public; only Jev spending (/api/decide) needs a session and play credit.
// This module talks to its bindings (PLAY_ACCOUNTS, ASSETS, AUTH_LIMITER) only
// through their interfaces, so `node --test` can drive it with fakes. The
// deployable entry that also exports the Durable Objects is server/entry.js.
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_SECONDS,
  STATE_SECONDS,
  sign,
  verify,
  derive,
  pkceChallenge,
  randomToken,
  readCookie,
  cookie,
  clearCookie,
  sessionUserId,
  validUserId,
} from "./auth.js";
import {
  providers,
  knownProvider,
  authorizeUrl,
  exchange,
} from "./providers.js";
import { usdToNano } from "./ledger.js";

const BODY_CAP = 250_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const decoder = new TextDecoder();

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    Object.assign(this, { status, extra });
  }
}

const json = (status, body, headers) => {
  const out = new Headers({ "Content-Type": "application/json" });
  for (const [key, value] of headers ?? []) out.append(key, value);
  return new Response(JSON.stringify(body), { status, headers: out });
};

const redirect = (status, location, cookies = []) => {
  const headers = new Headers({ Location: location });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status, headers });
};

function finish(response, api) {
  const out = new Response(response.body, response);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Frame-Options", "DENY");
  if (api) out.headers.set("Cache-Control", "no-store");
  return out;
}

// The one origin this request may be served on: APP_ORIGIN, or the request's
// own localhost origin when APP_ORIGIN itself is local (`wrangler dev`).
function siteOrigin(env, url) {
  let app;
  try {
    app = new URL(env.APP_ORIGIN);
  } catch {
    return { origin: null };
  }
  if (app.origin === url.origin) return { origin: app.origin };
  if (LOCAL_HOSTS.has(app.hostname) && LOCAL_HOSTS.has(url.hostname))
    return { origin: url.origin };
  return { origin: app.origin, foreign: true };
}

function guardPost(request, origin) {
  if (request.headers.get("Origin") !== origin)
    throw new HttpError(403, "Origin not allowed");
  if (
    !/^application\/json\s*(;|$)/i.test(
      request.headers.get("Content-Type") ?? "",
    )
  )
    throw new HttpError(403, "Content-Type must be application/json");
}

// Streams the body so an oversized upload is cut off, never buffered.
async function readJson(request) {
  const tooLarge = new HttpError(413, "Decision batch is too large.");
  if (Number(request.headers.get("Content-Length")) > BODY_CAP) throw tooLarge;
  const chunks = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BODY_CAP) {
        await reader.cancel().catch(() => {});
        throw tooLarge;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
}

const account = (env, userId) =>
  env.PLAY_ACCOUNTS.get(env.PLAY_ACCOUNTS.idFromName(userId));

async function status(request, env) {
  const body = {
    auth_required: true,
    authenticated: false,
    providers: providers(env),
    user: null,
    credits: null,
    // What a new account receives, so the sign-in dialog can say it before anyone has credits.
    grant_usd: usdToNano(env.PLAY_GRANT_USD, 0.1) / 1e9,
    configured: !!env.TYPESAFE_API_KEY,
    model: "jev-latest",
    pricing: {
      input_per_million: Number(env.JEV_INPUT_PRICE ?? 0.042),
      output_per_million: Number(env.JEV_OUTPUT_PRICE ?? 0),
    },
  };
  const headers = [];
  const userId = await sessionUserId(request, env.SESSION_SECRET);
  if (userId) {
    try {
      const snapshot = await account(env, userId).snapshot();
      if (snapshot?.user)
        Object.assign(body, {
          authenticated: true,
          user: snapshot.user,
          credits: snapshot.credits,
        });
      // A valid signature for an account that does not exist: drop it.
      else headers.push(["Set-Cookie", clearCookie(SESSION_COOKIE)]);
    } catch (e) {
      console.error("status: account unavailable", e?.message);
    }
  }
  return json(200, body, headers);
}

async function start(request, env, provider, origin) {
  guardPost(request, origin);
  if (env.AUTH_LIMITER) {
    const key = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.AUTH_LIMITER.limit({ key });
    if (!success)
      throw new HttpError(429, "Too many sign-in attempts. Try again shortly.");
  }
  if (!knownProvider(provider) || !providers(env).includes(provider))
    throw new HttpError(404, "Not found");
  const nonce = randomToken(16);
  // Throws (→ 503) when SESSION_SECRET is missing: never an unsigned state.
  const state = await sign(
    env.SESSION_SECRET,
    { nonce, provider },
    STATE_SECONDS,
  );
  const url = authorizeUrl(provider, env, {
    state,
    redirectUri: `${origin}/api/auth/${provider}/callback`,
    pkceChallenge: await pkceChallenge(
      await derive(env.SESSION_SECRET, `pkce:${nonce}`),
    ),
    nonce: await derive(env.SESSION_SECRET, `oidc:${nonce}`),
  });
  return json(200, { url }, [
    ["Set-Cookie", cookie(STATE_COOKIE, state, STATE_SECONDS)],
  ]);
}

async function callback(request, env, url, provider, origin) {
  const clear = clearCookie(STATE_COOKIE);
  const failed = redirect(303, "/play.html?auth=error", [clear]);
  try {
    const state = url.searchParams.get("state"),
      code = url.searchParams.get("code");
    if (
      !knownProvider(provider) ||
      url.searchParams.has("error") ||
      !code ||
      !state ||
      state !== readCookie(request, STATE_COOKIE)
    )
      return failed;
    const value = await verify(env.SESSION_SECRET, state);
    if (
      !value ||
      value.provider !== provider ||
      typeof value.nonce !== "string" ||
      !value.nonce
    )
      return failed;
    const identity = await exchange(provider, env, {
      code,
      redirectUri: `${origin}/api/auth/${provider}/callback`,
      pkceVerifier: await derive(env.SESSION_SECRET, `pkce:${value.nonce}`),
      nonce: await derive(env.SESSION_SECRET, `oidc:${value.nonce}`),
    });
    await account(env, identity.id).initialize(identity);
    const session = await sign(
      env.SESSION_SECRET,
      { user_id: identity.id },
      SESSION_SECONDS,
    );
    return redirect(303, "/play.html?auth=ok", [
      clear,
      cookie(SESSION_COOKIE, session, SESSION_SECONDS),
    ]);
  } catch (e) {
    console.error("callback failed:", e?.message);
    return failed;
  }
}

async function decide(request, env, origin) {
  guardPost(request, origin);
  // The session gate comes before a single body byte is read.
  const userId = await sessionUserId(request, env.SESSION_SECRET);
  if (!userId)
    throw new HttpError(401, "Sign in to play with Jev.", {
      auth_required: true,
    });
  const body = await readJson(request);
  const result = await account(env, userId).decide(body);
  return json(result.status, result.body);
}

// Constant-time comparison of two strings through their digests.
async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map((v) => crypto.subtle.digest("SHA-256", encoder.encode(v))),
  );
  const left = new Uint8Array(x),
    right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

// Owner-only manual credit. The route does not exist (404) until an
// ADMIN_TOKEN secret of at least 32 characters is set.
async function adminTopUp(request, env, origin) {
  const token = env.ADMIN_TOKEN;
  if (typeof token !== "string" || token.length < 32)
    throw new HttpError(404, "Not found");
  guardPost(request, origin);
  const given = /^Bearer (.{1,512})$/.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
  if (!given || !(await sameSecret(given, token)))
    throw new HttpError(401, "Unauthorized");
  const body = await readJson(request);
  const nano = Math.round(Number(body?.amount_usd) * 1e9);
  if (
    !validUserId(body?.user_id) ||
    typeof body?.order_id !== "string" ||
    !(nano > 0) ||
    nano > 100e9
  )
    throw new HttpError(
      400,
      "user_id, order_id and amount_usd (0-100) are required.",
    );
  const stub = account(env, body.user_id);
  // Never create an account for an id that has not signed in.
  if (!(await stub.snapshot())) throw new HttpError(404, "Unknown account.");
  try {
    return json(
      200,
      await stub.topUp({
        amount_nanodollars: nano,
        order_id: body.order_id,
        source: "manual",
      }),
    );
  } catch (e) {
    throw new HttpError(400, String(e?.message).slice(0, 120));
  }
}

async function api(request, env, url, origin) {
  const path = url.pathname,
    method = request.method;
  const allow = (expected) => {
    if (method !== expected) throw new HttpError(405, "Method not allowed");
  };
  if (path === "/api/status") {
    allow("GET");
    return status(request, env);
  }
  if (path === "/api/decide") {
    allow("POST");
    return decide(request, env, origin);
  }
  if (path === "/api/auth/logout") {
    allow("POST");
    guardPost(request, origin);
    return json(200, { ok: true }, [
      ["Set-Cookie", clearCookie(SESSION_COOKIE)],
    ]);
  }
  if (path === "/api/admin/topup") {
    allow("POST");
    return adminTopUp(request, env, origin);
  }
  const auth = /^\/api\/auth\/([a-z]{1,20})\/(start|callback)$/.exec(path);
  if (auth?.[2] === "start") {
    allow("POST");
    return start(request, env, auth[1], origin);
  }
  if (auth) {
    allow("GET");
    return callback(request, env, url, auth[1], origin);
  }
  throw new HttpError(404, "Not found");
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  let response;
  try {
    const site = siteOrigin(env, url);
    if (site.foreign)
      response = redirect(308, site.origin + url.pathname + url.search);
    else if (!isApi) response = await env.ASSETS.fetch(request);
    else if (!site.origin)
      throw new HttpError(503, "APP_ORIGIN is not configured.");
    else response = await api(request, env, url, site.origin);
  } catch (e) {
    if (e instanceof HttpError)
      response = json(e.status, { error: e.message, ...e.extra });
    else {
      console.error("worker:", e?.message);
      // A missing SESSION_SECRET lands here too: closed, not open.
      response = json(isApi ? 503 : 500, {
        error: "The server is temporarily unavailable.",
      });
    }
  }
  return finish(response, isApi);
}
