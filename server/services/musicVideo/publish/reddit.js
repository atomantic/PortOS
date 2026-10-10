/**
 * Reddit adapter (#9282, #9307).
 *
 * Video posts (the default, aimed at r/aivideo): the new composer at
 * www.reddit.com/r/<sub>/submit. Its file input only accepts a file from the
 * chooser a trusted click on its Video button opens (setting the hidden input
 * directly is ignored), so prepare() clicks Video and answers the chooser,
 * types the title, and picks the flair in the flair modal. submit() presses
 * Post and finds the new post in the account's submissions.
 *
 * Text and link posts go through old.reddit's own `/api/submit` with the
 * session's modhash. prepare() checks the session and reads the subreddit's
 * rules and post flairs either way, so the director sees what the sub requires
 * before posting; submit() posts, then adds the optional first comment.
 */
import { ServerError } from '../../../lib/errorHandler.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, landedOnPost, loginRequired, step } from './browser.js';

const BASE = 'https://old.reddit.com';
const WWW = 'https://www.reddit.com';
const label = 'Reddit';

/** The signed-in account, the sub's rules and its selectable flairs, read from the page's own session. */
function readSubreddit(page, subreddit) {
  return page.evaluate(async (sub) => {
    const me = await (await fetch('/api/me.json', { credentials: 'include' })).json().catch(() => ({}));
    if (!me?.data?.name) return { user: null };
    const rules = await (await fetch(`/r/${sub}/about/rules.json`)).json().catch(() => ({}));
    const flairs = await (await fetch(`/r/${sub}/api/link_flair_v2.json?uh=${me.data.modhash}`, { credentials: 'include' })).json().catch(() => []);
    return {
      user: me.data.name,
      rules: (rules.rules || []).map((r) => r.short_name).slice(0, 15),
      flairs: Array.isArray(flairs) ? flairs.filter((f) => !f.mod_only).map((f) => ({ id: f.id, text: f.text.trim() })).slice(0, 200) : [],
    };
  }, subreddit);
}

async function prepareVideo(page, payload) {
  const submitUrl = `${WWW}/r/${payload.subreddit}/submit/?type=MEDIA`;
  await step(label, 'open the composer', () => page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.waitForTimeout(3000);
  const info = await step(label, 'read the subreddit', () => readSubreddit(page, payload.subreddit));
  if (!info.user) throw loginRequired(label, `${WWW}/login`);
  await step(label, 'attach the video', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: T }),
      page.locator('post-composer-standalone-toolbar button').filter({ hasText: 'Video' }).first().click({ timeout: T }),
    ]);
    await chooser.setFiles(payload.video.path);
  });
  await step(label, 'set the title', async () => {
    await page.locator('post-composer-title textarea[name=title]').click({ timeout: T });
    await page.keyboard.insertText(payload.title);
  });
  const flair = payload.flairId ? info.flairs.find((f) => f.id === payload.flairId) : null;
  if (flair) {
    await step(label, 'pick the flair', async () => {
      await page.locator('#reddit-post-flair-button').click({ timeout: T });
      await page.waitForTimeout(1200);
      // The modal lists a few flairs until searched; searching surfaces the one we want.
      await page.getByPlaceholder('Search').last().click({ timeout: T });
      await page.keyboard.insertText(flair.text);
      await page.waitForTimeout(1200);
      await page.locator(`faceplate-radio-input[value="${flair.id}"]`).first().click({ timeout: T });
      await page.locator('r-post-flairs-modal button').filter({ hasText: /^\s*Add\s*$/ }).first().click({ timeout: T });
    });
  }
  await step(label, 'wait for the upload', () => page.waitForFunction(() => {
    const find = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.id === 'inner-post-submit-button') return el;
        if (el.shadowRoot) { const hit = find(el.shadowRoot); if (hit) return hit; }
      }
      return null;
    };
    const button = find(document);
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: 600_000 }));
  return {
    account: info.user, subreddit: payload.subreddit, kind: 'video', title: payload.title,
    flairText: flair?.text || null, rules: info.rules, flairs: info.flairs,
    ...(payload.flairId && !flair ? { warning: 'That flair is not offered in this subreddit — pick one and fill again' } : {}),
  };
}

async function submitVideo(page, payload) {
  await step(label, 'post', () => page.locator('#inner-post-submit-button').click({ timeout: T }));
  await step(label, 'wait for it to post', () => page.waitForURL((url) => !/\/submit/.test(url.toString()), { timeout: 180_000 }));
  const url = await step(label, 'find the new post', () => page.evaluate(async ({ title, firstComment }) => {
    const me = await (await fetch('/api/me.json', { credentials: 'include' })).json();
    const list = await (await fetch(`/user/${me.data.name}/submitted.json?limit=5`, { credentials: 'include' })).json();
    const hit = (list?.data?.children || []).map((c) => c.data).find((d) => d.title === title);
    if (hit?.name && firstComment) {
      await fetch('/api/comment', { method: 'POST', credentials: 'include', body: new URLSearchParams({ thing_id: hit.name, text: firstComment, api_type: 'json', uh: me.data.modhash }) });
    }
    return hit ? `https://www.reddit.com${hit.permalink}` : null;
  }, { title: payload.title, firstComment: payload.firstComment }));
  return { url };
}

export const redditAdapter = {
  label,
  async prepare(page, payload) {
    if (payload.kind === 'video') return prepareVideo(page, payload);
    await step(label, 'open Reddit', () => page.goto(`${BASE}/r/${payload.subreddit}/`, { waitUntil: 'domcontentloaded', timeout: T }));
    const info = await step(label, 'read the subreddit', () => readSubreddit(page, payload.subreddit));
    if (!info.user) throw loginRequired(label, `${BASE}/login`);
    return { account: info.user, subreddit: payload.subreddit, kind: payload.kind, title: payload.title, flairText: payload.flairText, rules: info.rules, flairs: info.flairs };
  },
  findPost: (page, payload) => landedOnPost(page, /^https:\/\/(?:www|old)\.reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/[^/?#]*)?/i, payload.title,
    ([url]) => url.replace('://old.reddit.com', '://www.reddit.com')),
  async submit(page, payload) {
    if (payload.kind === 'video') return submitVideo(page, payload);
    const result = await step(label, 'post', () => page.evaluate(async (p) => {
      const me = await (await fetch('/api/me.json', { credentials: 'include' })).json();
      const form = new URLSearchParams({
        sr: p.subreddit, kind: p.kind, title: p.title, api_type: 'json', uh: me.data.modhash, sendreplies: 'true', resubmit: 'true',
        ...(p.kind === 'link' ? { url: p.url, ...(p.body ? { text: p.body } : {}) } : { text: p.body || '' }),
        ...(p.flairId ? { flair_id: p.flairId } : {}), ...(p.flairText ? { flair_text: p.flairText } : {}),
      });
      const res = await (await fetch('/api/submit', { method: 'POST', body: form, credentials: 'include' })).json();
      if (res?.json?.errors?.length) return { error: res.json.errors.map((e) => e.join(': ')).join('; ') };
      const post = res?.json?.data;
      if (post?.name && p.firstComment) {
        await fetch('/api/comment', { method: 'POST', credentials: 'include', body: new URLSearchParams({ thing_id: post.name, text: p.firstComment, api_type: 'json', uh: me.data.modhash }) });
      }
      return { url: post?.url || null };
    }, payload));
    if (result.error) throw new ServerError(`Reddit refused the post: ${result.error}`, { status: 422, code: 'PUBLISH_REJECTED' });
    return { url: result.url ? result.url.replace('://old.reddit.com', '://www.reddit.com') : null };
  },
};
