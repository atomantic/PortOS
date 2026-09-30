/**
 * Reddit adapter (#9282). The new composer's video tool ignores files set by
 * automation, so this posts a text or link post through old.reddit's own
 * `/api/submit` with the signed-in session's modhash. prepare() checks the
 * session and reads the subreddit's rules and post flairs (so the director
 * sees what the sub requires before posting); submit() posts, then adds the
 * optional first comment.
 */
import { ServerError } from '../../../lib/errorHandler.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';

const BASE = 'https://old.reddit.com';
const label = 'Reddit';

export const redditAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open Reddit', () => page.goto(`${BASE}/r/${payload.subreddit}/`, { waitUntil: 'domcontentloaded', timeout: T }));
    const info = await step(label, 'read the subreddit', () => page.evaluate(async (sub) => {
      const me = await (await fetch('/api/me.json', { credentials: 'include' })).json().catch(() => ({}));
      if (!me?.data?.name) return { user: null };
      const rules = await (await fetch(`/r/${sub}/about/rules.json`)).json().catch(() => ({}));
      const flairs = await (await fetch(`/r/${sub}/api/link_flair_v2.json?uh=${me.data.modhash}`, { credentials: 'include' })).json().catch(() => []);
      return {
        user: me.data.name,
        rules: (rules.rules || []).map((r) => r.short_name).slice(0, 15),
        flairs: Array.isArray(flairs) ? flairs.filter((f) => !f.mod_only).map((f) => ({ id: f.id, text: f.text })).slice(0, 60) : [],
      };
    }, payload.subreddit));
    if (!info.user) throw loginRequired(label, `${BASE}/login`);
    return { account: info.user, subreddit: payload.subreddit, kind: payload.kind, title: payload.title, flairText: payload.flairText, rules: info.rules, flairs: info.flairs };
  },
  async submit(page, payload) {
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
