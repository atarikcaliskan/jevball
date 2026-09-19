// GitHub (OAuth 2) and Google (OpenID Connect) sign-in, server-to-server.
// Provider tokens are used once to read the identity and are never stored.
import { fromBase64Url } from "./auth.js";

const TIMEOUT_MS = 15000;
const decoder = new TextDecoder();

const CONFIG = {
  github: {
    client: "GITHUB_CLIENT_ID",
    secret: "GITHUB_CLIENT_SECRET",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
  },
  google: {
    client: "GOOGLE_CLIENT_ID",
    secret: "GOOGLE_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
};
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const configured = (env, id) =>
  typeof env[CONFIG[id].client] === "string" &&
  !!env[CONFIG[id].client] &&
  typeof env[CONFIG[id].secret] === "string" &&
  !!env[CONFIG[id].secret];

export const knownProvider = (id) => Object.hasOwn(CONFIG, id);

// Only providers with both of their secrets set are offered.
export const providers = (env) =>
  Object.keys(CONFIG).filter((id) => configured(env, id));

// Shown to every player: one generic message, details only in the log.
function failure(provider, detail) {
  console.error(`sign-in failed (${provider}): ${detail}`);
  return new Error("Sign-in failed. Please try again.");
}

export function cleanName(value) {
  const text =
    typeof value === "string"
      ? [...value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()]
          .slice(0, 80)
          .join("")
          .trim()
      : "";
  return text || "Player";
}

export function cleanAvatar(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (host === "avatars.githubusercontent.com" ||
        host.endsWith(".googleusercontent.com"))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function authorizeUrl(
  provider,
  env,
  { state, redirectUri, pkceChallenge, nonce },
) {
  if (!knownProvider(provider) || !configured(env, provider))
    throw new Error("Provider is not configured.");
  const config = CONFIG[provider];
  const url = new URL(config.authorize);
  const params =
    provider === "github"
      ? {
          client_id: env[config.client],
          redirect_uri: redirectUri,
          scope: "read:user",
          state,
        }
      : {
          client_id: env[config.client],
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: pkceChallenge,
          code_challenge_method: "S256",
        };
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return url.href;
}

async function postToken(provider, env, fields) {
  const config = CONFIG[provider];
  let res;
  try {
    res = await fetch(config.token, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "jevball",
      },
      body: new URLSearchParams({
        client_id: env[config.client],
        client_secret: env[config.secret],
        ...fields,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw failure(provider, `token endpoint unreachable (${e?.name})`);
  }
  if (!res.ok) throw failure(provider, `token endpoint HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw failure(provider, "token endpoint returned no JSON");
  }
  // GitHub reports a bad code as HTTP 200 + { error }.
  if (!data || typeof data !== "object" || data.error)
    throw failure(
      provider,
      `token endpoint error ${String(data?.error ?? "unknown").slice(0, 60)}`,
    );
  return data;
}

async function github(env, { code, redirectUri }) {
  const token = await postToken("github", env, {
    code,
    redirect_uri: redirectUri,
  });
  if (typeof token.access_token !== "string" || !token.access_token)
    throw failure("github", "no access token");
  let res;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "User-Agent": "jevball",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw failure("github", `user endpoint unreachable (${e?.name})`);
  }
  if (!res.ok) throw failure("github", `user endpoint HTTP ${res.status}`);
  const user = await res.json().catch(() => null);
  if (!Number.isSafeInteger(user?.id) || user.id <= 0)
    throw failure("github", "user has no numeric id");
  return {
    id: `gh_${user.id}`,
    name: cleanName(user.name || user.login),
    avatar_url: cleanAvatar(user.avatar_url),
    provider: "github",
  };
}

// The ID token comes straight from Google's token endpoint over TLS, so its
// claims are trusted without a JWKS signature check (OIDC Core 3.1.3.7).
async function google(env, { code, redirectUri, pkceVerifier, nonce }) {
  const token = await postToken("google", env, {
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: pkceVerifier,
  });
  let claims;
  try {
    const parts = String(token.id_token).split(".");
    if (parts.length !== 3) throw new Error("segments");
    claims = JSON.parse(decoder.decode(fromBase64Url(parts[1])));
  } catch {
    throw failure("google", "unreadable id_token");
  }
  const reject = (why) => failure("google", `id_token ${why}`);
  if (!claims || typeof claims !== "object") throw reject("is not an object");
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw reject("has a foreign iss");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw reject("has a foreign aud");
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now())
    throw reject("is expired");
  if (typeof nonce !== "string" || !nonce || claims.nonce !== nonce)
    throw reject("nonce mismatch");
  if (claims.email_verified !== true) throw reject("email is not verified");
  if (typeof claims.sub !== "string" || !/^[a-zA-Z0-9]{1,64}$/.test(claims.sub))
    throw reject("has no usable sub");
  return {
    id: `gg_${claims.sub}`,
    name: cleanName(claims.name || claims.given_name),
    avatar_url: cleanAvatar(claims.picture),
    provider: "google",
  };
}

// → { id: "gh_123" | "gg_<sub>", name, avatar_url, provider }
export async function exchange(provider, env, params) {
  if (!knownProvider(provider) || !configured(env, provider))
    throw failure(String(provider).slice(0, 20), "provider not configured");
  if (
    typeof params?.code !== "string" ||
    !params.code ||
    params.code.length > 2048
  )
    throw failure(provider, "missing or oversized code");
  return provider === "github" ? github(env, params) : google(env, params);
}
