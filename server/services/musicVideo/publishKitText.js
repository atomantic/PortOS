/**
 * Music Video — publishing kit text (#9281): YouTube chapters, an SRT of the
 * timed lyrics, and the per-platform copy prompt + parser. Pure: project in,
 * text out, so the kit build and the copy draft share one tested shape.
 */
import { extractJson } from '../../lib/jsonExtract.js';
import { fenceBlock } from '../../lib/promptFencing.js';

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const round3 = (n) => Math.round(n * 1000) / 1000;

// YouTube only turns a description's timestamps into chapters when the first
// is 0:00, there are at least three, and each runs at least 10 seconds.
export const MIN_CHAPTER_SEC = 10;
const MIN_CHAPTERS = 3;
const MAX_LABEL = 45;

function timedLines(project) {
  return (project?.lyricCues || [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && finite(c.startSec) != null)
    .map((c) => ({ text: c.text.trim(), startSec: c.startSec, endSec: finite(c.endSec) }))
    .sort((a, b) => a.startSec - b.startSec);
}

/** A lyric line as a chapter title: no closing punctuation or quotes, cut at a word. */
function chapterLabel(text) {
  // Double quotes go; an apostrophe inside a word (I’m) stays, only wrapping single quotes are trimmed.
  let s = String(text || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().replace(/^['‘’]+|['‘’]+$/g, '').replace(/[.,!?;:]+$/, '');
  if (s.length > MAX_LABEL) s = `${s.slice(0, MAX_LABEL).replace(/\s+\S*$/, '')}…`;
  return s;
}

/** Song sections as the board names them (consecutive scenes sharing a section label), else the analysis sections. */
function sectionRuns(project) {
  const scenes = (project?.scenes || [])
    .filter((s) => finite(s?.startSec) != null && finite(s?.endSec) != null && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const runs = [];
  for (const scene of scenes) {
    const section = typeof scene.sectionLabel === 'string' && scene.sectionLabel.trim() ? scene.sectionLabel.trim() : null;
    const last = runs[runs.length - 1];
    if (last && last.section === section) last.endSec = Math.max(last.endSec, scene.endSec);
    else runs.push({ section, startSec: scene.startSec, endSec: scene.endSec });
  }
  if (runs.length) return runs;
  return (project?.audioAnalysis?.sections || [])
    .filter((s) => finite(s?.startSec) != null && finite(s?.endSec) != null && s.endSec > s.startSec)
    .map((s) => ({ section: typeof s.label === 'string' ? s.label : null, startSec: s.startSec, endSec: s.endSec }));
}

/**
 * `[{ startSec, label }]` YouTube chapters: each section titled by its first
 * sung line (else its section name), sections shorter than 10 s folded into
 * the one before (a short opener folds forward), the first forced to 0:00.
 * Empty when the song can't make the three chapters YouTube requires.
 */
export function buildChapters(project) {
  const lines = timedLines(project);
  const runs = sectionRuns(project).map((run, i) => {
    const line = lines.find((l) => l.startSec >= run.startSec - 1e-6 && l.startSec < run.endSec);
    return { ...run, label: chapterLabel(line?.text) || run.section || `Part ${i + 1}` };
  });
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.endSec - run.startSec < MIN_CHAPTER_SEC) last.endSec = run.endSec;
    else if (last && last.label === run.label) last.endSec = run.endSec;
    else merged.push({ ...run });
  }
  if (merged.length > 1 && merged[0].endSec - merged[0].startSec < MIN_CHAPTER_SEC) {
    merged[1].startSec = merged[0].startSec;
    merged.shift();
  }
  if (merged.length < MIN_CHAPTERS) return [];
  merged[0].startSec = 0;
  return merged.map(({ startSec, label }) => ({ startSec: round3(startSec), label }));
}

function formatChapterTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export const chaptersText = (chapters) => chapters.map((c) => `${formatChapterTime(c.startSec)} ${c.label}`).join('\n');

const srtTime = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

// A cue stays up long enough to read, but never over the next line.
const MIN_CUE_SEC = 0.9;
const CUE_GAP_SEC = 0.02;

/** The timed lyrics as SubRip captions, or null when nothing is timed. */
export function buildSrt(project) {
  const lines = timedLines(project);
  if (!lines.length) return null;
  const cues = lines.map((line, i) => {
    const next = lines[i + 1];
    let end = Math.max(line.endSec ?? line.startSec + 2, line.startSec + MIN_CUE_SEC);
    if (next && next.startSec > line.startSec + 0.3) end = Math.min(end, next.startSec - CUE_GAP_SEC);
    return { ...line, endSec: Math.max(end, line.startSec + 0.3) };
  });
  return `${cues.map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.text}\n`).join('\n')}`;
}

// ---- per-platform copy (one user-triggered LLM call) ----

export const PUBLISH_PLATFORMS = Object.freeze(['youtube', 'shorts', 'x', 'tiktok', 'instagram', 'reddit', 'stackerNews']);
// Each platform's own title ceiling; the parser clips rather than rejecting.
const LIMITS = { youtubeTitle: 100, shortsTitle: 100, xHook: 280, redditTitle: 300, stackerNewsTitle: 80, caption: 2200 };

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

/**
 * What the director chose to put in the draft. Nothing beyond the notes and
 * links they typed is included unless they ticked it, and no hashtag or tag
 * appears unless they asked for them. `length: 'short'` keeps every post to a
 * sentence or two.
 */
export const DEFAULT_COPY_INCLUDE = Object.freeze({ title: true, lyrics: false, spend: false, chapters: false, hashtags: false });
export const COPY_LENGTHS = Object.freeze(['short', 'full']);

export function normalizeCopyOptions({ include, length } = {}) {
  const src = include && typeof include === 'object' ? include : {};
  const merged = Object.fromEntries(Object.entries(DEFAULT_COPY_INCLUDE).map(([k, d]) => [k, typeof src[k] === 'boolean' ? src[k] : d]));
  return { include: merged, length: COPY_LENGTHS.includes(length) ? length : 'short' };
}

// The JSON shape each platform's copy takes in the prompt.
function copySpecs({ include, length }) {
  const short = length === 'short';
  const tags = include.hashtags;
  const body = (full) => (short ? '1-2 sentences' : full);
  return {
    youtube: `"youtube":{"title":"<=100 chars","description":"${body('2 short paragraphs')} + the links given"${tags ? ',"tags":["8-15 lowercase tags"]' : ''}}`,
    shorts: `"shorts":{"title":"<=100 chars${tags ? ', ends with #shorts' : ''}","description":"1-2 sentences + the full video URL if given"}`,
    x: `"x":{"hook":"<=280 chars, ${short ? 'one or two sentences' : 'one surprising claim'}, no links","story":"${short ? 'empty string' : 'the making-of as a long post'}"}`,
    tiktok: `"tiktok":{"caption":"1-2 sentences${tags ? ' + 4-6 hashtags' : ''}"}`,
    instagram: `"instagram":{"caption":"1-2 sentences${tags ? ' + 4-6 hashtags' : ''}"}`,
    reddit: `"reddit":{"title":"<=300 chars","body":"${body('markdown: what it is and how it was made')}"}`,
    stackerNews: `"stackerNews":{"title":"<=80 chars","body":"${body('markdown, personal tone')}"}`,
  };
}

// A run of hashtags: `#` plus a word with at least one letter (so `#1` and
// `#2` stay), standing at a line start or after a space or opening bracket or
// quote (so a URL fragment like `/album/#listen` and `&#39;` stay), optionally
// wrapped whole in parentheses. Markdown headings ("# Heading") have a space
// after the `#` and never match.
const TAG = String.raw`#[\p{N}_]*\p{L}[\p{L}\p{N}_]*`;
const RUN = String.raw`${TAG}(?:[ \t]+${TAG})*`;
const HASHTAG_RUN = new RegExp(String.raw`([ \t]*)(?:(?<=^|[\s"'“‘])\(${RUN}\)|(?<=^|[\s(\[{"'“‘])${RUN})([ \t]*(?:\r?\n)?)`, 'gmu');
const CLOSING = /^[,.;:!?)\]}]/;
/**
 * The text with every hashtag removed. Only the spacing around a removed run
 * changes: a line that held only tags goes away, a run ending its line takes
 * the spaces before it, one before punctuation takes its space, and one
 * mid-line leaves a single space, so indentation and markdown line breaks
 * elsewhere are untouched.
 */
export const stripHashtags = (text) => String(text || '').replace(HASHTAG_RUN, (match, lead, trail, offset, whole) => {
  const end = offset + match.length;
  const lineStart = offset === 0 || whole[offset - 1] === '\n';
  const newline = trail.match(/\r?\n$/)?.[0] || '';
  if (newline || end >= whole.length) return lineStart ? '' : newline;
  if (lineStart) return lead;
  return lead && !CLOSING.test(whole.slice(end)) ? ' ' : '';
});

/**
 * The copy prompt. `notes` is the director's own making-of story; the song
 * title, lyrics, chapters and `spentUsd` (generation spend) reach the writer
 * only when `include` ticks them, and hashtags/tags only when it ticks
 * `hashtags`. Those are the only facts the copy may claim. `platforms` limits the
 * draft to where the director posts (#9287); `lessons` are their own ratings
 * of earlier posts (`{ platform, reception, notes }`), so the copy leans
 * toward what landed and away from what didn't.
 */
export function buildPublishCopyPrompt(project, { notes = '', spentUsd = null, links = {}, platforms = PUBLISH_PLATFORMS, lessons = [], include, length } = {}) {
  const options = normalizeCopyOptions({ include, length });
  const { include: inc } = options;
  const lyrics = inc.lyrics ? timedLines(project).map((l) => l.text).join('\n') : '';
  const chapters = inc.chapters ? chaptersText(buildChapters(project)) : '';
  const facts = [
    inc.title && project?.name ? `Song title: ${project.name}` : null,
    inc.spend && spentUsd != null ? `Video generation spend: $${Number(spentUsd).toFixed(2)}` : null,
    links.youtube ? `Full video URL: ${links.youtube}` : null,
    links.song ? `Song URL: ${links.song}` : null,
  ].filter(Boolean).join('\n');
  const wanted = PUBLISH_PLATFORMS.filter((p) => platforms.includes(p));
  const lessonText = lessons
    .filter((l) => wanted.includes(l.platform) && (l.reception || l.notes))
    .map((l) => `- ${l.platform}${l.reception ? ` (${l.reception})` : ''}: ${l.notes || 'no notes'}`)
    .join('\n');
  const specs = copySpecs(options);
  return [
    `You write release copy for a music video the user made. Write in the first person as the artist: plain, specific, no hype words, no emoji, ${inc.hashtags ? 'no hashtags except where a field asks for them' : 'no hashtags anywhere'}.`,
    options.length === 'short' ? 'Keep every post to a sentence or two. Leave out anything not needed.' : '',
    'Use ONLY facts given below. Never invent costs, tools, durations, lyrics, song titles or events, and do not mention anything the artist did not give you.',
    facts,
    fenceBlock('Making-of notes from the artist', notes || '(none)', 6000),
    lyrics ? fenceBlock('Lyrics', lyrics, 4000) : '',
    chapters ? fenceBlock('Chapters', chapters, 1200) : '',
    lessonText ? fenceBlock('How the artist rated earlier posts (lean toward what landed, avoid what did not)', lessonText, 3000) : '',
    'Return ONLY a JSON object with exactly these keys:',
    `{${wanted.map((p) => specs[p]).join(',\n ')}}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The model's JSON reply as `{ platform: { field: text } }` for `platforms`,
 * clipped to each platform's limits; null when unusable. Without
 * `hashtags: true` every hashtag the model slipped in is removed and no
 * YouTube tags are returned (the `tags` key is left out, so tags the director
 * typed survive a redraft), so none reaches a post unasked.
 */
export function parsePublishCopy(text, platforms = PUBLISH_PLATFORMS, { hashtags = true } = {}) {
  const { value } = extractJson(text, { blockType: 'object' });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = (fields) => (hashtags || !fields || typeof fields !== 'object' ? fields
    : Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'tags').map(([k, f]) => [k, typeof f === 'string' ? stripHashtags(f) : f])));
  const v = (k) => (value[k] && typeof value[k] === 'object' ? clean(value[k]) : {});
  const all = {
    youtube: () => ({
      title: str(v('youtube').title, LIMITS.youtubeTitle), description: str(v('youtube').description, 5000),
      ...(hashtags ? { tags: (Array.isArray(v('youtube').tags) ? v('youtube').tags : []).map((t) => str(t, 60)).filter(Boolean).slice(0, 20) } : {}),
    }),
    shorts: () => ({ title: str(v('shorts').title, LIMITS.shortsTitle), description: str(v('shorts').description, 5000) }),
    x: () => ({ hook: str(v('x').hook, LIMITS.xHook), story: str(v('x').story, 25000) }),
    tiktok: () => ({ caption: str(v('tiktok').caption, LIMITS.caption) }),
    instagram: () => ({ caption: str(v('instagram').caption, LIMITS.caption) }),
    reddit: () => ({ title: str(v('reddit').title, LIMITS.redditTitle), body: str(v('reddit').body, 40000) }),
    stackerNews: () => ({ title: str(v('stackerNews').title, LIMITS.stackerNewsTitle), body: str(v('stackerNews').body, 40000) }),
  };
  const copy = Object.fromEntries(PUBLISH_PLATFORMS.filter((p) => platforms.includes(p)).map((p) => [p, all[p]()]));
  const filled = Object.values(copy).some((fields) => Object.values(fields).some((f) => (Array.isArray(f) ? f.length : f)));
  return filled ? copy : null;
}
