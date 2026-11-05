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
import { isVitestRunner } from '../../../lib/runtimeEnv.js';

export const PUBLISH_STEP_TIMEOUT_MS = 60_000;

let browserTail = Promise.resolve();
// What holds the PortOS Browser now, so a queued fill can say what it waits on.
let activeOperation = null;
let pendingOperations = 0;

/**
 * Run `fn` after every earlier PortOS Browser operation settles. Typing goes to
 * whichever tab has focus, so every driver of the shared browser — a publish
 * draft or an autonomous Suno song — queues here, not on a private tail.
 */
export function serializeBrowserOperation(fn, operation = null) {
  pendingOperations += 1;
  const start = () => { activeOperation = operation ? { ...operation } : {}; return fn(); };
  const run = browserTail.then(start, start).finally(() => { pendingOperations -= 1; activeOperation = null; });
  browserTail = run.catch(() => {});
  return run;
}

/** `null` when the PortOS Browser is free, else `{ label, status }` of the operation holding it (either may be null). */
export function browserOperationInProgress() {
  if (!pendingOperations) return null;
  return { label: activeOperation?.label || null, status: activeOperation?.status || null };
}

/** Connect to the running PortOS Browser (launching it when it is stopped, unless `launch: false`). */
export async function connectPortosBrowser({ launch = true } = {}) {
  // The PortOS Browser carries the operator's real sign-ins (Suno, socials): a test
  // that misses a double must fail, never spend credits or post as the operator.
  if (isVitestRunner()) {
    throw new ServerError('Tests must not drive the real PortOS Browser; stub this dependency.', { status: 503, code: 'PORTOS_BROWSER_UNAVAILABLE' });
  }
  const { getHealthStatus, launchBrowser } = await import('../../browserService.js');
  let health = await getHealthStatus();
  if (!health.connected && launch) health = await launchBrowser();
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
// A timeout usually means the tab was hidden mid-step (the director switched tabs in the PortOS Browser).
const timeoutHint = (err) => (/timeout/i.test(err?.message || '') ? '. Leave the PortOS Browser on the tab it opened while it fills, then Fill again' : '');
export const stepFailed = (label, step, err) => new ServerError(`${label}: ${step} (${err?.message?.split('\n')[0] || 'timed out'})${timeoutHint(err)}`, {
  status: 502, code: 'PUBLISH_STEP_FAILED', context: { platform: label, step },
});

/**
 * Run one named step of a platform fill, turning a Playwright timeout into a
 * `stepFailed` naming it. `status` is what the director reads while it runs
 * (default: the step's name); the operation holding the browser reports it
 * through its `onStep`. Its tab is brought to the front first: a background
 * tab stops painting, so a click waiting for the element to settle stalls
 * until it times out (LinkedIn and Facebook fills failed that way while the
 * director used other tabs).
 */
export async function step(label, name, fn, { status } = {}) {
  if (activeOperation) {
    activeOperation.status = status || name;
    try { activeOperation.onStep?.(activeOperation.status); } catch (err) { console.error(`❌ Publish step report failed: ${err.message}`); }
    await activeOperation.focus?.()?.catch?.(() => {});
  }
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

/**
 * Whether the tab now shows the post the director made by hand: its URL is the
 * platform's page for a new post (`pattern`) and the page shows the post's
 * title, so browsing elsewhere in the filled tab never counts. Resolves the
 * post's link (`canonical` of the match) or null. Nothing is pressed.
 */
export async function landedOnPost(page, pattern, title, canonical = (match) => match[0]) {
  const match = page.url().match(pattern);
  const want = String(title || '').trim().slice(0, 40);
  if (!match || !want) return null;
  const shown = await page.waitForFunction((t) => (document.body?.innerText || '').includes(t), want, { timeout: 15_000 }).then(() => true, () => false);
  return shown ? canonical(match) : null;
}
