// Hosted sign-in and play credit (docs/AUTH.md). Locally /api/status says
// auth_required:false and nothing in here is ever shown.
import { providerGlyph, refreshIcons } from "./hud-markup.js";
import { credit, creditLevel, initials } from "./hud-format.js";

const $ = (id) => document.getElementById(id);
const PROVIDERS = { github: "GitHub", google: "Google" };
const JSON_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

// Why Jev is off although the visitor is signed in (account sheet).
const NOTES = {
  credit: "Full-time on your free credit. The local policy has taken over; the match plays on.",
  cap: "Jev's shared budget for today is spent, so the local policy is playing. Your credit is untouched.",
  offline: "Jev is not available on this server right now. The local policy is playing.",
};

// Only ever load an avatar over https, and never leak the page URL to its host.
function paintAvatar(holder, user) {
  holder.replaceChildren();
  holder.dataset.initials = initials(user?.name);
  let url = null;
  try {
    url = new URL(user?.avatar_url);
  } catch {
    // No usable avatar: the initials disc stays.
  }
  if (url?.protocol !== "https:") return;
  const img = new Image();
  img.alt = "";
  img.width = img.height = holder.classList.contains("large") ? 40 : 24;
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  img.onerror = () => img.remove();
  img.src = url.href;
  holder.append(img);
}

// `hooks`: toast(text, type), onOpen() before a sheet opens (drop held input),
// onSignedOut() after the server cleared the session.
export class AuthHud {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.status = null;
    this.hold = null;
    this.busy = false;
    this.whistled = false;
    this.dialog = $("auth-dialog");
    this.sheet = $("account-sheet");

    $("auth-signin").onclick = () => this.open();
    $("close-auth").onclick = $("auth-dismiss").onclick = () => this.dialog.close();
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    // Coming back with the browser's Back button must not leave dead buttons.
    this.onPageShow = (event) => event.persisted && this.setBusy(false);
    window.addEventListener("pageshow", this.onPageShow);

    $("auth-account").onclick = () => this.toggleSheet();
    $("auth-signout").onclick = () => this.signOut();
    // Keys pressed in the sheet are for the sheet, not for the match.
    this.sheet.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") this.closeSheet(true);
    });
    this.sheet.addEventListener("focusout", (event) => {
      if (!this.sheet.contains(event.relatedTarget) && event.relatedTarget !== $("auth-account"))
        this.closeSheet();
    });
    this.onOutside = (event) => {
      if (this.sheet.hidden || event.target.closest?.("#account-sheet, #auth-account")) return;
      this.closeSheet();
    };
    document.addEventListener("pointerdown", this.onOutside);
    this.onResize = () => this.closeSheet();
    window.addEventListener("resize", this.onResize);
    $("whistle-close").onclick = () => this.hideWhistle();

  }

  // status: the hosted /api/status body, or null in local mode (no auth UI).
  // hold: why Jev is off although signed in: "credit" | "cap" | "offline" | null.
  render(status, hold = null) {
    this.status = status?.auth_required ? status : null;
    this.hold = hold;
    const hosted = !!this.status,
      user = hosted && this.status.authenticated ? this.status.user : null;
    document.body.classList.toggle("hosted", hosted);
    $("auth-slab").hidden = !hosted;
    $("auth-signin").hidden = !!user;
    $("auth-account").hidden = !user;
    if (!user) this.closeSheet();
    if (!hosted || user) {
      if (this.dialog.open) this.dialog.close();
    } else this.renderDialog();
    if (!user) return;
    const name = user.name || "Signed in";
    $("auth-name").textContent = $("sheet-name").textContent = name;
    $("sheet-provider").textContent = `via ${PROVIDERS[user.provider] ?? "your provider"} · ${user.id ?? ""}`;
    paintAvatar($("auth-avatar"), user);
    paintAvatar($("sheet-avatar"), user);
    this.renderCredits();
  }

  setCredits(credits) {
    if (!this.status || !credits) return;
    this.status.credits = credits;
    if (this.status.authenticated) this.renderCredits();
  }

  setHold(hold) {
    if (this.hold === hold) return;
    this.hold = hold;
    if (this.status?.authenticated) this.renderCredits();
  }

  renderCredits() {
    const credits = this.status?.credits,
      { fraction, tone } = creditLevel(credits),
      amount = credits ? credit(credits.remaining_usd) : "–",
      width = `${(fraction * 100).toFixed(1)}%`;
    for (const [text, bar] of [
      ["auth-credit", "auth-credit-bar"],
      ["sheet-credit", "sheet-credit-bar"],
    ]) {
      if ($(text).textContent !== amount) $(text).textContent = amount;
      if ($(bar).style.width !== width) $(bar).style.width = width;
    }
    $("auth-account").dataset.tone = this.sheet.dataset.tone = tone;
    $("auth-account").setAttribute(
      "aria-label",
      `${this.status.user?.name || "Account"}: ${amount} play credit left. Open account and sign-out.`,
    );
    const ledger = credits
      ? [
          `Granted ${credit(credits.granted_usd)}`,
          `Spent ${credit(credits.spent_usd)}`,
        ]
.join(" · ")
      : "";
    if ($("sheet-ledger").textContent !== ledger) $("sheet-ledger").textContent = ledger;
    const note = NOTES[tone === "out" ? "credit" : this.hold] ?? "";
    $("sheet-note").textContent = note;
    $("sheet-note").hidden = !note;
  }

  // ------------------------------------------------------------ sign-in dialog
  renderDialog() {
    const status = this.status,
      // Signed-out status has no ledger yet; a server may still announce the grant.
      grant = Number(status.credits?.granted_usd ?? status.grant_usd);
    // Measured ≈ $0.01 of Jev per match-minute; deliberately phrased as a rough figure.
    const minutes = Math.round(grant / 0.01);
    $("auth-lede").textContent = `All 22 players switch from the local policy to Jev. You get ${
      grant > 0
        ? `$${grant.toFixed(2)} of free play credit${minutes >= 1 ? ` — roughly ${minutes === 10 ? "ten" : minutes} match-minute${minutes === 1 ? "" : "s"}` : ""}`
        : "free play credit"
    }, no card needed. When it is used up, the local policy simply takes over again.`;
    const wanted = (status.providers ?? []).filter((p) => PROVIDERS[p]);
    const box = $("auth-providers");
    if (box.dataset.providers !== wanted.join()) {
      box.dataset.providers = wanted.join();
      box.innerHTML = wanted
        .map(
          (p) =>
            `<button class="provider" data-provider="${p}">${providerGlyph(p)}<span>Continue with ${PROVIDERS[p]}</span></button>`,
        )
        .join("");
      for (const button of box.querySelectorAll("button"))
        button.onclick = () => this.start(button.dataset.provider);
    }
    if (!wanted.length) this.showError("Sign-in is not set up on this server yet.");
  }

  open() {
    if (!this.status || this.status.authenticated) return;
    this.hooks.onOpen?.();
    this.renderDialog();
    if ((this.status.providers ?? []).some((p) => PROVIDERS[p])) this.showError("");
    this.setBusy(false);
    if (!this.dialog.open) this.dialog.showModal();
  }

  showError(text) {
    $("auth-error").textContent = text;
    $("auth-error").hidden = !text;
  }

  setBusy(busy) {
    this.busy = busy;
    this.dialog.setAttribute("aria-busy", String(busy));
    for (const button of $("auth-providers").querySelectorAll("button"))
      button.disabled = busy;
  }

  async start(provider) {
    if (this.busy || !PROVIDERS[provider]) return;
    this.setBusy(true);
    this.showError("");
    try {
      const response = await fetch(`/api/auth/${provider}/start`, JSON_POST);
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.url)
        throw Error(body?.error || "Sign-in could not be started. Please try again.");
      const url = new URL(body.url, location.href);
      if (!["https:", "http:"].includes(url.protocol))
        throw Error("Sign-in could not be started. Please try again.");
      // Buttons stay disabled: the browser is leaving for the provider.
      location.assign(url.href);
    } catch (error) {
      this.setBusy(false);
      this.showError(
        error instanceof TypeError
          ? "Could not reach the server. Check your connection and try again."
          : error.message,
      );
      $("auth-providers").querySelector(`[data-provider="${provider}"]`)?.focus();
    }
  }

  // ------------------------------------------------------------- account sheet
  toggleSheet() {
    if (this.sheet.hidden) this.openSheet();
    else this.closeSheet(true);
  }

  openSheet() {
    if (!this.status?.authenticated) return;
    this.hooks.onOpen?.();
    const anchor = $("auth-account").getBoundingClientRect();
    this.sheet.style.setProperty(
      "--sheet-right",
      `${Math.max(10, Math.round(innerWidth - anchor.right))}px`,
    );
    this.sheet.hidden = false;
    $("auth-account").setAttribute("aria-expanded", "true");
    refreshIcons();
    this.sheet.focus({ preventScroll: true });
  }

  closeSheet(refocus = false) {
    if (this.sheet.hidden) return;
    this.sheet.hidden = true;
    $("auth-account").setAttribute("aria-expanded", "false");
    if (refocus) $("auth-account").focus({ preventScroll: true });
  }

  async signOut() {
    const button = $("auth-signout");
    if (button.disabled) return;
    button.disabled = true;
    this.hooks.onSigningOut?.();
    try {
      const response = await fetch("/api/auth/logout", JSON_POST);
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      this.closeSheet();
      await this.hooks.onSignedOut?.();
    } catch {
      this.hooks.onSignOutFailed?.();
      this.hooks.toast?.("Sign-out did not go through. Please try again.", "error");
    } finally {
      button.disabled = false;
    }
  }

  // ------------------------------------------------ lower third: credit is out
  // Shown once per page; afterwards the status block carries the message.
  creditWhistle() {
    if (this.whistled) return false;
    this.whistled = true;
    $("whistle-tag").textContent = "Full-time";
    $("whistle-title").textContent = "on your free credit";
    $("whistle-text").textContent = "The local policy has taken over — the match plays on.";
    $("toast").hidden = true;
    $("credit-whistle").hidden = false;
    clearTimeout(this.whistleTimer);
    this.whistleTimer = setTimeout(() => this.hideWhistle(), 12000);
    return true;
  }

  hideWhistle() {
    clearTimeout(this.whistleTimer);
    $("credit-whistle").hidden = true;
  }

  dispose() {
    clearTimeout(this.whistleTimer);
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerdown", this.onOutside);
  }
}
