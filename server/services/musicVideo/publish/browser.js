/**
 * Music Video publishing (#9282) — the PortOS Browser session every platform
 * adapter drives, plus the editor/file helpers the platforms need. Lessons
 * from driving these UIs by hand are encoded here once:
 *
 * - Connect with `isLocal: true`: Playwright otherwise refuses to hand a file
 *   over 50 MB to a browser it thinks is remote, and every video upload is.
 * - Draft.js / Lexical editors (X, TikTok, Stacker News) ignore `fill()` and
 *   drop newlines from typed text; a synthetic `paste` event lands the text
 *   the way a user's paste does.
 * - Each draft gets its OWN new tab, so a fill can never land in another tab
 *   that happens to match the same URL (a YouTube Studio edit page of an
 *   already-published video matched `studio.youtube.com` once and was edited).
 */
import { ServerError } from '../../../lib/errorHandler.js';

export const PUBLISH_STEP_TIMEOUT_MS = 60_000;

/** Connect to the running PortOS Browser (launching it when it is stopped). */
export async function connectPortosBrowser() {
  const { getHealthStatus, launchBrowser } = await import('../../browserService.js');
  let health = await getHealthStatus();
  if (!health.connected) health = await launchBrowser();
  if (!health.connected) {
    throw new ServerError('PortOS Browser is unavailable. Start it in Settings › Browser, then retry.', { status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
  }
  const host = health.cdpHost === '0.0.0.0' || health.cdpHost === '::' ? '127.0.0.1' : health.cdpHost;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`http://${host}:${health.cdpPort}`, { isLocal: true, noDefaults: true, timeout: 30_000 });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new ServerError('PortOS Browser has no usable profile context.', { status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
  }
  return { browser, context };
}

/** A platform needs the user to sign in, in the PortOS Browser, before a draft can be filled. */
export const loginRequired = (label, url) => new ServerError(`Sign in to ${label} in the PortOS Browser, then fill the draft again`, {
  status: 409, code: 'PUBLISH_LOGIN_REQUIRED', context: { platform: label, url },
});

/** A step the page never reached: say which, so a UI change is diagnosable. */
export const stepFailed = (label, step, err) => new ServerError(`${label}: ${step} (${err?.message?.split('\n')[0] || 'timed out'})`, {
  status: 502, code: 'PUBLISH_STEP_FAILED', context: { platform: label, step },
});

/** Run one named step, turning a Playwright timeout into a `stepFailed` naming it. */
export async function step(label, name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServerError) throw err;
    throw stepFailed(label, name, err);
  }
}

/** Paste `text` into the first element matching `selector`, as a user's paste would. */
export async function pasteText(page, selector, text) {
  const ok = await page.evaluate(([sel, txt]) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    const data = new DataTransfer();
    data.setData('text/plain', txt);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return true;
  }, [selector, text]);
  if (!ok) throw new Error(`no editor matched ${selector}`);
}

/** Replace a contenteditable's text: focus, select all, delete, then paste. */
export async function replaceEditorText(page, selector, text) {
  await page.locator(selector).first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await pasteText(page, selector, text);
}

/** Click the last VISIBLE element whose trimmed text is exactly `text` (dialogs stack their buttons last). */
export async function clickVisibleText(page, text, { selector = 'button,[role=button]' } = {}) {
  const clicked = await page.evaluate(([sel, want]) => {
    const found = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && (e.innerText || '').trim() === want);
    const target = found[found.length - 1];
    if (!target) return false;
    target.click();
    return true;
  }, [selector, text]);
  if (!clicked) throw new Error(`no visible "${text}" control`);
}

/** Turn on the switch/checkbox that sits beside a label, when it is off. Returns its final state. */
export async function ensureToggleBeside(page, labelText) {
  return page.evaluate((want) => {
    const label = [...document.querySelectorAll('span,div,label')].find((e) => e.children.length === 0 && e.textContent.trim() === want);
    if (!label) return null;
    let node = label;
    for (let i = 0; i < 8 && node; i += 1) {
      node = node.parentElement;
      const sw = node?.querySelector('[role=switch],input[type=checkbox]');
      if (sw) {
        const on = sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
        if (!on) sw.click();
        return true;
      }
    }
    return null;
  }, labelText);
}
