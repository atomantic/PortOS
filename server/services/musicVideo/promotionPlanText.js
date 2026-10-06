/**
 * Music Video — promotion plan prompt + parser. Pure: project in, prompt out;
 * model reply in, human action steps out (see lib/humanActions.js).
 *
 * The plan is a short run of dated steps only the artist can take (post a
 * clip, answer replies, join a conversation), each with explicit instructions
 * and the exact text to paste, so the artist never has to remember or decide
 * on the day. PortOS never posts: every step ends with the artist pressing Post.
 */
import { extractJson } from '../../lib/jsonExtract.js';
import { fenceBlock } from '../../lib/promptFencing.js';
import { anchorLocalMidnightUtc, nextLocalTime, parseHHMM, todayInTimezone } from '../../lib/timezone.js';

export const PROMOTION_PLAN_MAX_STEPS = 20;

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Planning the same project again replaces its open steps. */
export const promotionPlanKey = (projectId) => `promo-${String(projectId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 40).replace(/-+$/, '');

function timedLyrics(project) {
  return (project?.lyricCues || [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && finite(c.startSec) != null)
    .sort((a, b) => a.startSec - b.startSec)
    .map((c) => `${clock(c.startSec)} ${c.text.trim()}`)
    .join('\n');
}

/** The posted links as `{ platform: url }`, http(s) only. */
export function postedLinks(project) {
  const posts = project?.publishKit?.posts && typeof project.publishKit.posts === 'object' ? project.publishKit.posts : {};
  return Object.fromEntries(Object.entries(posts)
    .map(([platform, post]) => [platform, typeof post?.url === 'string' ? post.url.trim() : ''])
    .filter(([, url]) => /^https?:\/\//i.test(url)));
}

/**
 * The plan prompt. `goal` and `audience` are the artist's own words; `cuts`
 * are suggested clip windows (`{ startSec, endSec, label }`); `days` bounds the
 * schedule. Only given facts may be claimed.
 */
export function buildPromotionPlanPrompt(project, { goal = '', audience = '', days = 7, cuts = [], timezone = 'UTC' } = {}) {
  const links = postedLinks(project);
  const copy = project?.publishKit?.copy && typeof project.publishKit.copy === 'object' ? project.publishKit.copy : {};
  const facts = [
    project?.name ? `Song title: ${project.name}` : null,
    `Artist's timezone: ${timezone}`,
    Object.keys(links).length ? `Already posted:\n${Object.entries(links).map(([p, url]) => `- ${p}: ${url}`).join('\n')}` : 'Nothing has been posted yet.',
    cuts.length ? `Suggested clip windows from the video:\n${cuts.map((c) => `- ${clock(c.startSec)}–${clock(c.endSec)}${c.label ? ` (${c.label})` : ''}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
  const copyText = Object.entries(copy)
    .map(([platform, fields]) => `${platform}: ${Object.values(fields || {}).filter((v) => typeof v === 'string' && v.trim()).join(' / ')}`)
    .filter((line) => line.length > 3)
    .join('\n');
  return [
    `Plan the next ${days} days of promotion for a music video the artist made, as a short list of dated steps ONLY THE ARTIST can do by hand (nobody posts for them). The aim is more of the right people seeing it, without looking like spam or getting the account downranked.`,
    'How the platforms reward attention (use this):',
    [
      '- Conversation counts most: replies, and the artist answering them quickly. Plan short sessions answering replies.',
      '- Reach beyond followers comes from taking part in conversations the target audience is already having: thoughtful replies with an opinion, no link and no video.',
      '- Short hook clips (15–40 s) as NEW posts, each quote-posting or linking the full video, one every day or two. Never the same clip or caption twice.',
      '- Links in a main X post cut its reach: keep links in a reply under the post.',
      '- Avoid: link-dropping in other people\'s replies, tagging people who are not involved, hashtag stacks, deleting and reposting, engagement pods, asking for likes.',
    ].join('\n'),
    'Style: few words. Every post or reply the artist pastes is a sentence or two at most, first person, plain, no emoji, no hashtags, no hype. Use ONLY the facts given; never invent links, numbers or events.',
    goal ? fenceBlock('What the artist wants', goal, 1500) : '',
    audience ? fenceBlock('Who they want to reach', audience, 1000) : '',
    facts,
    copyText ? fenceBlock('Copy already written for this release', copyText, 3000) : '',
    timedLyrics(project) ? fenceBlock('Timed lyrics (pick hook lines for clips from these)', timedLyrics(project), 4000) : '',
    `Return ONLY a JSON object: {"steps":[{"title":"…","day":0,"time":"18:00","priority":"normal","instructions":["…"],"content":[{"label":"…","text":"…"}],"links":[{"label":"…","url":"…"}]}]}`,
    [
      `- At most ${PROMOTION_PLAN_MAX_STEPS} steps. "day" is 0–${days - 1} (0 is today), "time" is local HH:MM, chosen for when the audience is online.`,
      '- "title": what to do, in a few words (e.g. "Post the opening clip on X").',
      '- "instructions": explicit, numbered-ready steps a person can follow without thinking: which clip (with its timestamps), where to tap, what to paste, what to check. 2–6 short lines.',
      '- "content": every piece of text to paste, exactly as it should be posted, each labelled with where it goes. Empty only for steps with nothing to paste.',
      '- "links": only links from "Already posted"; empty otherwise.',
      '- "priority": "high" for the steps that matter most, else "normal".',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

/** Local `day` (0 = today) at `time` HH:MM in `timezone`, as an ISO instant; never in the past. */
function promotionStepDueAt(day, time, timezone, now = Date.now()) {
  const today = todayInTimezone(timezone, new Date(now));
  const [y, m, d] = today.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + day)).toISOString().slice(0, 10);
  const midnight = anchorLocalMidnightUtc(target, timezone);
  const minutes = parseHHMM(time) ?? 18 * 60;
  const due = Number.isFinite(midnight) ? nextLocalTime(midnight, Math.floor(minutes / 60), minutes % 60, timezone) : now;
  // A slot that already passed today becomes "in a few minutes".
  return new Date(Math.max(due, now + 5 * 60_000)).toISOString();
}

/**
 * The model's reply as human action steps (`humanActionStepSchema` shape), or
 * null when unusable. Links the model was not given are dropped.
 */
export function parsePromotionPlan(text, { days = 7, timezone = 'UTC', now = Date.now(), allowedLinks = [] } = {}) {
  const { value } = extractJson(text, { blockType: 'object' });
  const raw = Array.isArray(value?.steps) ? value.steps : null;
  if (!raw) return null;
  const allowed = new Set(allowedLinks);
  const steps = raw.slice(0, PROMOTION_PLAN_MAX_STEPS).flatMap((step) => {
    if (!step || typeof step !== 'object') return [];
    const title = str(step.title, 200);
    const instructions = (Array.isArray(step.instructions) ? step.instructions : []).map((l) => str(l, 500)).filter(Boolean).slice(0, 20);
    if (!title || !instructions.length) return [];
    const day = Math.min(Math.max(Math.round(Number(step.day) || 0), 0), days - 1);
    return [{
      title,
      dueAt: promotionStepDueAt(day, typeof step.time === 'string' ? step.time : '', timezone, now),
      instructions,
      content: (Array.isArray(step.content) ? step.content : [])
        .map((c) => ({ label: str(c?.label, 100), text: str(c?.text, 5000) }))
        .filter((c) => c.label && c.text)
        .slice(0, 10),
      links: (Array.isArray(step.links) ? step.links : [])
        .map((l) => ({ label: str(l?.label, 200), url: str(l?.url, 2000) }))
        .filter((l) => allowed.has(l.url))
        .slice(0, 10),
      priority: ['high', 'urgent'].includes(step.priority) ? 'high' : 'normal',
    }];
  });
  return steps.length ? steps : null;
}
