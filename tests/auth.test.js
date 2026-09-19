import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE,
  sign,
  verify,
  derive,
  pkceChallenge,
  toBase64Url,
  fromBase64Url,
  readCookie,
  cookie,
  clearCookie,
  sessionUserId,
} from "../server/auth.js";

const SECRET = "test-only-session-secret-0123456789abcdef";
const T0 = 1_800_000_000_000;
const withCookie = (value) =>
  new Request("https://jevball.test/", { headers: { Cookie: value } });

test("base64url round-trips bytes and rejects foreign alphabets", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const text = toBase64Url(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromBase64Url(text), bytes);
  for (const bad of ["a+b/", "a=", "", "a", null])
    assert.throws(() => fromBase64Url(bad));
});

test("sign → verify returns the value until it expires", async () => {
  const token = await sign(SECRET, { user_id: "gh_1" }, 60, T0);
  assert.deepEqual(await verify(SECRET, token, T0 + 59_000), {
    user_id: "gh_1",
  });
  assert.equal(await verify(SECRET, token, T0 + 60_000), null);
});

test("tampered, malformed, oversized and foreign tokens are rejected", async () => {
  const token = await sign(SECRET, { user_id: "gh_1" }, 60, T0);
  const [payload, mac] = token.split(".");
  const forged = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ value: { user_id: "gh_2" }, exp: T0 + 1e9 }),
    ),
  );
  const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
  for (const bad of [
    `${forged}.${mac}`,
    `${payload}.${flipped}`,
    `${payload}.${mac}.extra`,
    payload,
    `.${mac}`,
    "",
    null,
    42,
    "not a token",
    `${payload}.${"A".repeat(5000)}`,
  ])
    assert.equal(await verify(SECRET, bad, T0), null, String(bad).slice(0, 30));
  assert.equal(await verify(SECRET + "x", token, T0), null);
});

test("a missing or short secret fails closed", async () => {
  const token = await sign(SECRET, { user_id: "gh_1" }, 60, T0);
  for (const secret of [undefined, null, "", "short"]) {
    await assert.rejects(sign(secret, { user_id: "gh_1" }, 60, T0));
    assert.equal(await verify(secret, token, T0), null);
    assert.equal(
      await sessionUserId(withCookie(`${SESSION_COOKIE}=${token}`), secret, T0),
      null,
    );
  }
});

test("derive is deterministic per label and yields a valid PKCE verifier", async () => {
  const a = await derive(SECRET, "pkce:n1");
  assert.equal(a, await derive(SECRET, "pkce:n1"));
  assert.notEqual(a, await derive(SECRET, "pkce:n2"));
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  // RFC 7636 appendix B
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("cookies: parsing and __Host- attributes", () => {
  const request = withCookie("a=1; __Host-jevball=tok.en ;b=2; a=3");
  assert.equal(readCookie(request, "__Host-jevball"), "tok.en");
  assert.equal(readCookie(request, "a"), "1");
  assert.equal(readCookie(request, "missing"), null);
  assert.equal(readCookie(new Request("https://x.test/"), "a"), null);
  assert.equal(
    cookie("__Host-jevball", "v", 60),
    "__Host-jevball=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60",
  );
  assert.ok(!/Domain/i.test(cookie("n", "v", 1)));
  assert.match(clearCookie("__Host-jevball"), /^__Host-jevball=; .*Max-Age=0$/);
});

test("sessionUserId accepts only well-formed provider ids", async () => {
  const session = async (value) =>
    sessionUserId(
      withCookie(`${SESSION_COOKIE}=${await sign(SECRET, value, 60, T0)}`),
      SECRET,
      T0,
    );
  assert.equal(await session({ user_id: "gh_123" }), "gh_123");
  assert.equal(
    await session({ user_id: "gg_1098765432101234567" }),
    "gg_1098765432101234567",
  );
  for (const user_id of [
    "xx_1",
    "gh_",
    "gh_1/../2",
    "gh_" + "1".repeat(65),
    7,
    null,
  ])
    assert.equal(await session({ user_id }), null);
  assert.equal(await session("gh_123"), null);
  assert.equal(await sessionUserId(withCookie("other=1"), SECRET, T0), null);
});
