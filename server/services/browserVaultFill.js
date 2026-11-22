/**
 * Model-blind, origin-bound fill of Privacy Vault website logins into a managed-browser tab over CDP (#17397).
 *
 * The caller (operator UI, an authorized agent, or the `browser.vault.fill`
 * tool) names a tab and a login; the host process decrypts the login and
 * injects it. No plaintext username, password, TOTP seed or generated code is
 * ever returned, thrown or logged: results are metadata, refusals carry fixed
 * codes, and raw CDP/page exception text is never surfaced.
 *
 * Origin binding fails closed and cannot be spoofed by the page:
 *   - the browser-reported top-frame `securityOrigin` (Page.getFrameTree) must
 *     EXACTLY equal one of the login's stored origins, before decrypting and
 *     again after the settle window, with the same document `loaderId`;
 *   - every page script runs in a CDP isolated world, so page monkeypatches of
 *     `Document.prototype`, `location` readers or input setters can't fake
 *     the origin or intercept the injection logic;
 *   - each value write re-checks the live origin and top-level frame inside the
 *     same JS task that writes it;
 *   - any main-frame load or navigation during the fill refuses it.
 * Fields are located in the verified top document only (open shadow roots
 * included); a login form inside any iframe is not found, so it fails closed.
 *
 * The identifier is typed with `Input.insertText` (trusted input events, which
 * framework-controlled forms accept) after focusing the field, falling back to
 * the native value setter when the page didn't retain it. The password and TOTP
 * code go through the native value setter plus `input`/`change` events, never
 * as page-wide keystrokes. Forms are never submitted.
 *
 * The password and generated code are registered with the ephemeral secret
 * scrubber (lib/secretText.js) before injection, so tool results, prompts and
 * DOM reads that later echo them are redacted. A raw CDP client attached to the
 * browser outside PortOS can still read the DOM; that is host-level access.
 */

import { ServerError } from '../lib/errorHandler.js';
import { sleep } from '../lib/fileUtils.js';
import { generateTotp } from '../lib/totp.js';
import { registerEphemeralSecret } from '../lib/secretText.js';
import { WEBSITE_LOGIN_DEFAULT_FILL_FIELDS, WEBSITE_LOGIN_FILL_FIELDS, normalizeLoginOrigin } from '../lib/websiteLoginValidation.js';

const SETTLE_MS = 400;
const PASSWORD_SCRUB_TTL_MS = 60 * 60 * 1000;
// A code this close to rollover would likely be stale by the time the form is
// submitted; wait for the next step instead.
const TOTP_MIN_REMAINING_MS = 3000;
const ISOLATED_WORLD_NAME = 'portos-vault-fill';

// ---------- Page scripts (run in the isolated world; plain strings so no build
// or coverage transform can capture module scope) ----------

// `this` = the isolated world's document. Returns the matching visible <input>
// in the top document (open shadow roots included) or null.
const LOCATE_FIELD_SOURCE = `function (kind, selector) {
  const doc = this;
  const win = doc.defaultView;
  const usable = (el) => {
    if (!(el instanceof win.HTMLInputElement) || el.disabled || el.readOnly || el.type === 'hidden') return false;
    const style = win.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  };
  if (selector) {
    let el = null;
    try { el = doc.querySelector(selector); } catch { return null; }
    return el && usable(el) ? el : null;
  }
  const collect = (root, out) => {
    for (const el of root.querySelectorAll('input')) out.push(el);
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot, out);
    return out;
  };
  const inputs = collect(doc, []).filter(usable);
  const hints = (el) => [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')]
    .filter(Boolean).join(' ').toLowerCase();
  const autocomplete = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();
  const passwords = inputs.filter((el) => el.type === 'password');
  if (kind === 'password') {
    return passwords.find((el) => autocomplete(el).includes('current-password'))
      || passwords.find((el) => !autocomplete(el).includes('new-password'))
      || null;
  }
  const textual = inputs.filter((el) => ['text', 'email', 'tel', 'number'].includes(el.type));
  const anchor = passwords[0] || null;
  const otpHint = /one.?time|otp|2fa|mfa|verification|verify|auth.?code|security.?code|passcode/;
  let best = null;
  let bestScore = 0;
  for (const el of textual) {
    const text = hints(el);
    const ac = autocomplete(el);
    let score = 0;
    if (kind === 'identifier') {
      if (ac.includes('one-time-code') || otpHint.test(text) || /search|query/.test(text)) continue;
      if (ac.includes('username') || ac.split(/\\s+/).includes('email')) score += 4;
      if (el.type === 'email') score += 3;
      if (/user|e-?mail|login|account|identifier|phone|mobile/.test(text)) score += 2;
      if (anchor && el.form && el.form === anchor.form) score += 2;
      if (anchor && (el.compareDocumentPosition(anchor) & 4)) score += 1;
      if (score < 2) continue;
    } else {
      if (ac.includes('username') || el.type === 'email') continue;
      if (ac.includes('one-time-code')) score += 5;
      if (otpHint.test(text) || /\\b(code|token)\\b/.test(text)) score += 3;
      if (el.getAttribute('inputmode') === 'numeric') score += 1;
      if (el.maxLength >= 6 && el.maxLength <= 8) score += 1;
      if (score < 3) continue;
    }
    if (score > bestScore) { best = el; bestScore = score; }
  }
  return best;
}`;

// Shared prologue for the per-field functions (`this` = the field): the field
// must still be connected, in the top-level document, on an allowed origin.
const FIELD_GUARD = `
  const doc = this.ownerDocument;
  const win = doc && doc.defaultView;
  if (!win || win !== win.top || !this.isConnected) return { ok: false, reason: 'detached' };
  if (!allowedOrigins.includes(win.location.origin)) return { ok: false, reason: 'origin' };`;

// Focus is checked on the field's own root: inside a shadow root,
// `document.activeElement` is the host, never the input itself.
const FOCUS_FIELD_SOURCE = `function (allowedOrigins) {${FIELD_GUARD}
  this.focus();
  if (typeof this.select === 'function') this.select();
  return { ok: this.getRootNode().activeElement === this, reason: 'focus' };
}`;

const SET_FIELD_SOURCE = `function (value, allowedOrigins) {${FIELD_GUARD}
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
  this.focus();
  setter.call(this, value);
  // Same flags as native events: \`input\` is composed (it escapes a shadow
  // root to a framework listening outside it); \`change\` is not.
  this.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new win.Event('change', { bubbles: true }));
  return { ok: true };
}`;

// The identifier compares trimmed and case-folded: sites commonly normalize an
// email as it's typed. Secrets compare exactly.
const FIELD_HOLDS_SOURCE = `function (value, allowedOrigins, loose) {${FIELD_GUARD}
  const fold = (text) => (loose ? String(text).trim().toLowerCase() : text);
  return { ok: fold(this.value) === fold(value), reason: 'retained' };
}`;

// ---------- Refusals (fixed messages; never a value) ----------

const refusal = (status, code, message) => new ServerError(message, { status, code });
const REFUSALS = {
  tabNotFound: () => refusal(404, 'BROWSER_TAB_NOT_FOUND', 'No managed-browser page tab has that id'),
  originMismatch: () => refusal(403, 'ORIGIN_MISMATCH', "The tab's live origin is not one of this login's allowed origins"),
  navigated: () => refusal(409, 'NAVIGATED_DURING_FILL', 'The page loaded or navigated during the fill; nothing is reported as filled'),
  notRetained: (field) => refusal(409, 'VALUE_NOT_RETAINED', `The page did not retain the ${field} value after the settle window`),
  fieldNotFound: (fields) => refusal(422, 'FIELD_NOT_FOUND', `No fillable ${fields.join(', ')} field was found in the top document`),
  noTotp: () => refusal(400, 'LOGIN_HAS_NO_TOTP', 'This login has no saved TOTP setup key'),
  busy: () => refusal(409, 'BROWSER_FILL_BUSY', 'A fill is already running in that tab'),
  unavailable: () => refusal(503, 'BROWSER_UNAVAILABLE', 'The managed browser is not reachable'),
  failed: () => refusal(502, 'BROWSER_FILL_FAILED', 'The browser rejected a fill step'),
};

const orderFields = (fields) => {
  const requested = new Set(fields?.length ? fields : WEBSITE_LOGIN_DEFAULT_FILL_FIELDS);
  return WEBSITE_LOGIN_FILL_FIELDS.filter((field) => requested.has(field));
};

/**
 * Build a filler over injectable boundaries. Production wiring is
 * `fillWebsiteLogin` below; the real-Chrome suite passes a Playwright CDP
 * session, unit suites a scripted one.
 *   listPages()           → CDP target list ({ id, type, url, webSocketDebuggerUrl })
 *   openSession(page)     → { send, on, close }
 *   getLogin(id)          → metadata ({ id, origins, hasTotp }) or null — no decrypt
 *   readLogin(id)         → decrypted { username, password, totp } (fill-only)
 */
export function createBrowserVaultFiller({
  listPages, openSession, getLogin, readLogin,
  settleMs = SETTLE_MS, now = Date.now, wait = sleep,
}) {
  const inFlightTargets = new Set();

  const fillOnce = async ({ targetId, loginId, fields, selectors = {} }) => {
    const ordered = orderFields(fields);
    const login = await getLogin(loginId);
    if (!login) throw new ServerError('Website login not found', { status: 404, code: 'WEBSITE_LOGIN_NOT_FOUND' });
    if (ordered.includes('totp') && !login.hasTotp) throw REFUSALS.noTotp();
    const allowedOrigins = login.origins;

    const pages = await listPages().catch(() => { throw REFUSALS.unavailable(); });
    const page = pages.find((candidate) => candidate.id === targetId && candidate.type === 'page');
    if (!page) throw REFUSALS.tabNotFound();
    // Cheap early refusal from the target list; the authoritative checks follow.
    if (!allowedOrigins.includes(normalizeLoginOrigin(page.url))) throw REFUSALS.originMismatch();

    const session = await Promise.resolve().then(() => openSession(page)).catch(() => { throw REFUSALS.unavailable(); });
    let mainFrameId = null;
    let navigated = false;
    try {
      const send = (method, params) => session.send(method, params);
      session.on('Page.frameNavigated', ({ frame }) => { if (!frame?.parentId) navigated = true; });
      session.on('Page.frameStartedLoading', ({ frameId }) => { if (frameId === mainFrameId) navigated = true; });
      await send('Page.enable');
      const readTopFrame = async () => (await send('Page.getFrameTree')).frameTree?.frame ?? null;
      const before = await readTopFrame();
      mainFrameId = before?.id ?? null;
      if (!before || !allowedOrigins.includes(normalizeLoginOrigin(before.securityOrigin))) throw REFUSALS.originMismatch();

      const world = await send('Page.createIsolatedWorld', { frameId: mainFrameId, worldName: ISOLATED_WORLD_NAME });
      const docRef = await send('Runtime.evaluate', { expression: 'document', contextId: world.executionContextId });
      const documentId = docRef.result?.objectId;
      if (!documentId) throw REFUSALS.failed();

      const callOn = async (objectId, source, args, { byValue = true } = {}) => {
        const response = await send('Runtime.callFunctionOn', {
          objectId, functionDeclaration: source, arguments: args.map((value) => ({ value })),
          returnByValue: byValue, silent: true,
        });
        if (response.exceptionDetails) throw REFUSALS.failed();
        return response.result;
      };
      const guarded = async (objectId, source, args, field) => {
        const outcome = (await callOn(objectId, source, args)).value;
        if (navigated) throw REFUSALS.navigated();
        if (outcome?.reason === 'origin') throw REFUSALS.originMismatch();
        if (outcome?.reason === 'detached') throw REFUSALS.navigated();
        if (outcome?.ok !== true && outcome?.reason === 'retained') throw REFUSALS.notRetained(field);
        return outcome;
      };

      // Locate every requested field before decrypting or writing anything, so
      // a missing field refuses the whole fill with nothing written.
      const elements = {};
      for (const field of ordered) {
        const located = await callOn(documentId, LOCATE_FIELD_SOURCE, [field, selectors[field] ?? null], { byValue: false });
        if (located?.objectId) elements[field] = located.objectId;
      }
      const missing = ordered.filter((field) => !elements[field]);
      if (missing.length) throw REFUSALS.fieldNotFound(missing);
      if (navigated) throw REFUSALS.navigated();

      const secrets = await readLogin(loginId);
      const values = {};
      if (ordered.includes('identifier')) values.identifier = secrets.username;
      if (ordered.includes('password')) {
        values.password = secrets.password;
        registerEphemeralSecret(secrets.password, { ttlMs: PASSWORD_SCRUB_TTL_MS });
      }
      if (ordered.includes('totp')) {
        if (!secrets.totp) throw REFUSALS.noTotp();
        let code = generateTotp(secrets.totp, { now: now() });
        if (code.expiresAt - now() < TOTP_MIN_REMAINING_MS) {
          await wait(Math.max(0, code.expiresAt - now()) + 50);
          code = generateTotp(secrets.totp, { now: now() });
        }
        values.totp = code.code;
        // Valid for the rest of this step plus the one-step grace most sites allow.
        registerEphemeralSecret(code.code, { ttlMs: code.expiresAt - now() + secrets.totp.period * 1000 });
      }

      for (const field of ordered) {
        if (field === 'identifier') {
          const focus = await guarded(elements.identifier, FOCUS_FIELD_SOURCE, [allowedOrigins], field);
          if (focus.ok) await send('Input.insertText', { text: values.identifier });
          const typed = (await callOn(elements.identifier, FIELD_HOLDS_SOURCE, [values.identifier, allowedOrigins, true])).value;
          if (navigated) throw REFUSALS.navigated();
          if (typed?.reason === 'origin') throw REFUSALS.originMismatch();
          if (typed?.ok === true) continue;
        }
        await guarded(elements[field], SET_FIELD_SOURCE, [values[field], allowedOrigins], field);
      }

      await wait(settleMs);
      if (navigated) throw REFUSALS.navigated();
      for (const field of ordered) {
        await guarded(elements[field], FIELD_HOLDS_SOURCE, [values[field], allowedOrigins, field === 'identifier'], field);
      }
      const after = await readTopFrame();
      if (navigated || !after || after.id !== before.id || after.loaderId !== before.loaderId) throw REFUSALS.navigated();
      const origin = normalizeLoginOrigin(after.securityOrigin);
      if (!allowedOrigins.includes(origin)) throw REFUSALS.originMismatch();
      return {
        ok: true,
        loginId,
        targetId,
        origin,
        filledFields: ordered,
        identifierFilled: ordered.includes('identifier'),
        totpFilled: ordered.includes('totp'),
        submitted: false,
      };
    } catch (error) {
      if (error instanceof ServerError) throw error;
      // A stale context after a navigation surfaces as a CDP command failure.
      throw navigated ? REFUSALS.navigated() : REFUSALS.failed();
    } finally {
      session.close();
    }
  };

  return {
    async fill(request) {
      if (inFlightTargets.has(request.targetId)) throw REFUSALS.busy();
      inFlightTargets.add(request.targetId);
      try {
        const result = await fillOnce(request);
        console.log(`🔑 Browser vault fill: login ${request.loginId} → tab ${request.targetId} (${result.filledFields.join(', ')})`);
        return result;
      } catch (error) {
        console.log(`🚫 Browser vault fill refused: login ${request.loginId} → tab ${request.targetId} (${error.code || 'error'})`);
        throw error;
      } finally {
        inFlightTargets.delete(request.targetId);
      }
    },
  };
}

let defaultFiller = null;

/** Production fill against the managed browser and the Privacy Vault. */
export async function fillWebsiteLogin(request) {
  if (!defaultFiller) {
    const [{ listCdpPages, openCdpSession }, logins] = await Promise.all([
      import('./browserService.js'),
      import('./privacyWebsiteLogins.js'),
    ]);
    defaultFiller = createBrowserVaultFiller({
      listPages: () => listCdpPages({ strict: true }),
      openSession: (page) => openCdpSession(page.webSocketDebuggerUrl),
      getLogin: logins.getWebsiteLogin,
      readLogin: logins.readWebsiteLoginForFill,
    });
  }
  return defaultFiller.fill(request);
}
