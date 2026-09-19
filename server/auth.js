// Stateless signed tokens and cookies for the hosted Worker. WebCrypto only,
// so the same module runs in Workers and under `node --test`.
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

export const SESSION_COOKIE = "__Host-jevball",
  STATE_COOKIE = "__Host-jevball-oauth",
  SESSION_SECONDS = 30 * 24 * 3600,
  STATE_SECONDS = 600;
const USER_ID = /^(gh|gg)_[a-zA-Z0-9]{1,64}$/,
  MAX_TOKEN = 4096,
  MIN_SECRET = 32;

export function toBase64Url(bytes) {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (
    typeof text !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(text) ||
    text.length % 4 === 1
  )
    throw new Error("invalid base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 16) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export const validUserId = (id) => typeof id === "string" && USER_ID.test(id);

// A missing or short secret must never sign or verify anything.
function hmacKey(secret) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET)
    throw new Error("SESSION_SECRET is missing or shorter than 32 characters.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// token = base64url({ value, exp }) + "." + base64url(HMAC-SHA256(payload))
export async function sign(secret, value, seconds, now = Date.now()) {
  const key = await hmacKey(secret);
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ value, exp: now + seconds * 1000 })),
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(mac)}`;
}

// Returns the signed value, or null for anything that is not a live token.
export async function verify(secret, token, now = Date.now()) {
  try {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN)
      return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!ok) return null;
    const data = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
    if (!data || typeof data !== "object" || !Number.isFinite(data.exp))
      return null;
    return data.exp > now ? (data.value ?? null) : null;
  } catch {
    return null;
  }
}

// Secrets that must exist server-side only (the PKCE verifier) are derived
// from the signed state's nonce instead of travelling inside it.
export async function derive(secret, label) {
  const key = await hmacKey(secret);
  return toBase64Url(
    await crypto.subtle.sign("HMAC", key, encoder.encode(label)),
  );
}

export async function pkceChallenge(verifier) {
  return toBase64Url(
    await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  );
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 16384) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim() || null;
  }
  return null;
}

// `__Host-` cookies require Secure, Path=/ and no Domain attribute.
export const cookie = (name, value, seconds) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}`;

export const clearCookie = (name) => cookie(name, "", 0);

export async function sessionUserId(request, secret, now = Date.now()) {
  const value = await verify(secret, readCookie(request, SESSION_COOKIE), now);
  return validUserId(value?.user_id) ? value.user_id : null;
}
