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

// Playwright serializes this callback, so the request helpers live in the page.
async function evaluateReddit({ action, payload: p }) {
  async function requestJson(path, options) {
    const endpoint = path.split('?')[0];
    const signal = AbortSignal.timeout(15_000);
    let response;
    try {
      response = await fetch(path, { credentials: 'include', ...options, signal });
      if (!response.ok) return { error: `${endpoint} returned HTTP ${response.status}`, status: response.status };
      return { data: await response.json() };
    } catch (err) {
      if (signal.aborted || err?.name === 'TimeoutError') return { error: `${endpoint} timed out after 15 seconds` };
      return { error: response ? `${endpoint} returned invalid JSON` : `${endpoint} could not be reached (network error)` };
    }
  }

  function checkApiResult(endpoint, result) {
    if (result.error) return result;
    const body = result.data?.json;
    if (!Array.isArray(body?.errors)) return { error: `${endpoint} returned an invalid response` };
    if (body.errors.length) return { rejected: body.errors.map((entry) => Array.isArray(entry) ? entry.join(': ') : String(entry)).join('; ') || 'request rejected' };
    return { data: body.data };
  }

  async function addFirstComment(post, modhash) {
    if (!p.firstComment) return {};
    // The post already exists. Keep its URL even if the comment fails.
    const commentError = (error) => ({ warning: `Reddit could not add the starter comment: ${error}` });
    if (!post?.name) return commentError('the new post could not be identified');
    const result = checkApiResult('/api/comment', await requestJson('/api/comment', {
      method: 'POST',
      body: new URLSearchParams({ thing_id: post.name, text: p.firstComment, api_type: 'json', uh: modhash }),
    }));
    const error = result.error || result.rejected;
    return error ? commentError(error) : {};
  }

  const session = await requestJson('/api/me.json');
  if (action !== 'findVideo' && (session.status === 401 || session.status === 403)) return { user: null };
  if (session.error) return session;
  const { name, modhash } = session.data?.data ?? {};
  if (!name && action !== 'findVideo') return { user: null };
  if (typeof name !== 'string' || !name) return { error: '/api/me.json returned no signed-in account' };
  if (typeof modhash !== 'string' || !modhash) return { error: '/api/me.json returned no session token' };

  if (action === 'read') {
    const rules = await requestJson(`/r/${p.subreddit}/about/rules.json`);
    if (rules.error) return rules;
    const flairs = await requestJson(`/r/${p.subreddit}/api/link_flair_v2.json?uh=${encodeURIComponent(modhash)}`);
    if (flairs.error) return flairs;
    return {
      user: name,
      rules: (rules.data?.rules || []).map((r) => r.short_name).slice(0, 15),
      flairs: Array.isArray(flairs.data) ? flairs.data.filter((f) => !f.mod_only).map((f) => ({ id: f.id, text: f.text.trim() })).slice(0, 200) : [],
    };
  }

  if (action === 'findVideo') {
    const list = await requestJson(`/user/${encodeURIComponent(name)}/submitted.json?limit=5`);
    if (list.error) return list;
    const hit = (list.data?.data?.children || []).map((c) => c.data).find((d) => d.title === p.title);
    return {
      url: hit ? `https://www.reddit.com${hit.permalink}` : null,
      ...await addFirstComment(hit, modhash),
    };
  }

  const form = new URLSearchParams({
    sr: p.subreddit, kind: p.kind, title: p.title, api_type: 'json', uh: modhash, sendreplies: 'true', resubmit: 'true',
    ...(p.kind === 'link' ? { url: p.url, ...(p.body ? { text: p.body } : {}) } : { text: p.body || '' }),
    ...(p.flairId ? { flair_id: p.flairId } : {}), ...(p.flairText ? { flair_text: p.flairText } : {}),
  });
  const result = checkApiResult('/api/submit', await requestJson('/api/submit', { method: 'POST', body: form }));
  if (result.error || result.rejected) return result;
  const post = result.data;
  return { url: post?.url || null, ...await addFirstComment(post, modhash) };
}

function redditStep(page, name, action, payload, base) {
  return step(label, name, async () => {
    const result = await page.evaluate(evaluateReddit, { action, payload });
    if (result.error) throw new Error(result.error);
    if (result.user === null) throw loginRequired(label, `${base}/login`);
    if (result.rejected) throw new ServerError(`Reddit refused the post: ${result.rejected}`, { status: 422, code: 'PUBLISH_REJECTED' });
    return result;
  });
}

async function prepareVideo(page, payload) {
  const submitUrl = `${WWW}/r/${payload.subreddit}/submit/?type=MEDIA`;
  await step(label, 'open the composer', () => page.goto(submitUrl, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.waitForTimeout(3000);
  const info = await redditStep(page, 'read the subreddit', 'read', { subreddit: payload.subreddit }, WWW);
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
  return redditStep(page, 'find the new post', 'findVideo', { title: payload.title, firstComment: payload.firstComment }, WWW);
}

export const redditAdapter = {
  label,
  async prepare(page, payload) {
    if (payload.kind === 'video') return prepareVideo(page, payload);
    await step(label, 'open Reddit', () => page.goto(`${BASE}/r/${payload.subreddit}/`, { waitUntil: 'domcontentloaded', timeout: T }));
    const info = await redditStep(page, 'read the subreddit', 'read', { subreddit: payload.subreddit }, BASE);
    return { account: info.user, subreddit: payload.subreddit, kind: payload.kind, title: payload.title, flairText: payload.flairText, rules: info.rules, flairs: info.flairs };
  },
  findPost: (page, payload) => landedOnPost(page, /^https:\/\/(?:www|old)\.reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/[^/?#]*)?/i, payload.title,
    ([url]) => url.replace('://old.reddit.com', '://www.reddit.com')),
  async submit(page, payload) {
    if (payload.kind === 'video') return submitVideo(page, payload);
    const result = await redditStep(page, 'post', 'submit', payload, BASE);
    return { ...result, url: result.url ? result.url.replace('://old.reddit.com', '://www.reddit.com') : null };
  },
};
