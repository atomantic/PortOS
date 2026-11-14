import { ServerError } from '../../../lib/errorHandler.js';

const interrupted = () => new ServerError('X typing stopped before the draft was verified. Review the open tab before continuing.', {
  status: 409, code: 'PUBLISH_EDIT_INTERRUPTED',
});

/** Enter one grapheme at a time; Enter creates Draft.js blocks instead of dropping newlines. */
export async function typeXText(page, selector, text) {
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw new Error('X text contains an unsupported control character');
  const editor = page.locator(selector).first();
  await editor.click();
  const ready = await editor.evaluate((el) => {
    if (document.activeElement !== el || el.textContent !== '') return false;
    const state = { el, stopped: false, expectedKey: null };
    const stop = () => { state.stopped = true; };
    const key = (event) => {
      if (state.expectedKey === event.key && !state.stopped && event.target === el && !event.ctrlKey && !event.metaKey && !event.altKey) {
        state.expectedKey = null;
        return;
      }
      stop();
      // A pending automated Enter must never activate a control after focus moves.
      if (state.expectedKey === 'Enter' && event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const beforeInput = (event) => {
      if (state.stopped) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('pointerdown', stop, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('beforeinput', beforeInput, true);
    document.addEventListener('visibilitychange', visibility, true);
    el.addEventListener('blur', stop, true);
    state.cleanup = () => {
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('beforeinput', beforeInput, true);
      document.removeEventListener('visibilitychange', visibility, true);
      el.removeEventListener('blur', stop, true);
    };
    window.__portosXTyping = state;
    return true;
  });
  if (!ready) throw interrupted();
  try {
    const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
    for (const { segment } of characters) {
      const safe = await page.evaluate((key) => {
        const state = window.__portosXTyping;
        if (!state || state.stopped || document.hidden || document.activeElement !== state.el || !state.el.isConnected) return false;
        state.expectedKey = key;
        return true;
      }, segment === '\n' ? 'Enter' : [...segment][0]);
      if (!safe) throw interrupted();
      if (segment === '\n') await page.keyboard.press('Enter');
      else await page.keyboard.type(segment);
      await page.evaluate(() => { if (window.__portosXTyping) window.__portosXTyping.expectedKey = null; });
      await new Promise(resolve => setTimeout(resolve, 45 + Math.floor(Math.random() * 81)));
    }
    const result = await page.evaluate(() => {
      const state = window.__portosXTyping;
      if (!state || state.stopped || document.hidden || document.activeElement !== state.el || !state.el.isConnected) return null;
      const blocks = [...state.el.querySelectorAll('[data-block=true]')];
      return blocks.length ? blocks.map(block => block.textContent).join('\n') : state.el.innerText;
    });
    if (result !== text) throw interrupted();
  } catch (err) {
    if (err?.code === 'PUBLISH_EDIT_INTERRUPTED') throw err;
    const failure = interrupted();
    failure.cause = err;
    throw failure;
  } finally {
    await page.evaluate(() => { window.__portosXTyping?.cleanup(); delete window.__portosXTyping; }).catch(() => {});
  }
}
