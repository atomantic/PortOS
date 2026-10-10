/**
 * Suno song links and song pages — the pure half of the track import from a
 * Suno URL. Accepts a song page (`suno.com/song/<uuid>`) or a share link
 * (`suno.com/s/<code>`, which redirects to one), and reads the song's title,
 * lyrics, style and audio/cover URLs out of the page HTML.
 *
 * A pure leaf: the client imports `isSunoSongUrl` to route a pasted URL to the
 * right import endpoint, so this module imports no Node built-in.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A Suno song page or share link on suno.com / suno.ai (www. and app. too). */
export const SUNO_SONG_URL_RE = new RegExp(
  `^https?:\\/\\/(?:www\\.|app\\.)?suno\\.(?:com|ai)\\/(?:song\\/${UUID}|s\\/[A-Za-z0-9_-]{4,64})\\/?(?:[?#]\\S*)?$`,
  'i',
);

export const SUNO_URL_INVALID_MESSAGE = 'Paste a Suno song link (suno.com/song/… or suno.com/s/…)';

const SONG_ID_RE = new RegExp(`\\/song\\/(${UUID})`, 'i');

export const isSunoSongUrl = (url) => typeof url === 'string' && SUNO_SONG_URL_RE.test(url.trim());

/** The song id in a `/song/<uuid>` URL (lower-cased), or null — a share link carries none until resolved. */
export function sunoSongIdFromUrl(url) {
  return typeof url === 'string' ? SONG_ID_RE.exec(url)?.[1]?.toLowerCase() ?? null : null;
}

/** Suno's own hosts — the only places the import follows a share link or downloads from. */
export function isSunoHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ['suno.com', 'suno.ai'].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Suno's CDN copy of a song's audio, used when the page names none. */
export const sunoCdnAudioUrl = (songId) => `https://cdn1.suno.ai/${encodeURIComponent(songId)}.mp3`;

/** Suno's CDN copy of a song's video, which stays public when Suno withholds the audio file. */
export const sunoCdnVideoUrl = (songId) => `https://cdn1.suno.ai/${encodeURIComponent(songId)}.mp4`;

// Media lives on Suno's CDN hosts (cdn1.suno.ai, …). A page can name an API
// placeholder such as studio-api…/api/forbidden instead, which is no media at all.
const isSunoCdnUrl = (value) => {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && /^cdn\d*\.suno\.(?:ai|com)$/i.test(url.hostname);
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

function metaContent(html, property) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== property) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return decodeEntities(value).trim();
  }
  return '';
}

// The page is a Next.js app: the song record rides in `self.__next_f.push([1,"…"])`
// script chunks, each a JSON string literal. Decoded and joined they make
// React's flight stream, whose rows hold the song's JSON.
function flightPayload(html) {
  const parts = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { parts.push(JSON.parse(m[1])); } catch { /* a chunk that isn't a plain string literal */ }
  }
  return parts.join('');
}

// The flight stream moves a long string (lyrics, often) into its own raw
// `<id>:T<hex byte length>,<text>` row and leaves `"$<id>"` in its place. Cut
// those rows out — their unescaped quotes and braces would derail the JSON
// scan — and keep their text by id.
function splitTextRows(payload) {
  const texts = new Map();
  const row = /(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/gi;
  let json = '';
  let pos = 0;
  for (let m = row.exec(payload); m; m = row.exec(payload)) {
    const start = m.index + m[0].length;
    const byteLength = parseInt(m[2], 16);
    // A character is at least one byte, so the text fits in byteLength chars.
    const bytes = new TextEncoder().encode(payload.slice(start, start + byteLength)).slice(0, byteLength);
    const text = new TextDecoder().decode(bytes);
    texts.set(m[1].toLowerCase(), text);
    json += `${payload.slice(pos, m.index)}\n`;
    pos = start + text.length;
    row.lastIndex = pos;
  }
  return { json: json + payload.slice(pos), texts };
}

// Every object in the stream that has `"id":"<songId>"` as one of its own
// keys, parsed. One forward pass tracks string state and an open-brace stack,
// so the song's record parses whole however Suno orders its keys, and a parent
// song nested in its `history` can't cut it short.
function objectsWithId(json, songId) {
  const needle = `"id":"${songId}"`;
  const starts = [];
  const wanted = new Set();
  const found = [];
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      if (starts.length && json.slice(i, i + needle.length).toLowerCase() === needle) wanted.add(starts[starts.length - 1]);
      inString = true;
    } else if (c === '{') {
      starts.push(i);
    } else if (c === '}' && starts.length) {
      const from = starts.pop();
      if (!wanted.has(from)) continue;
      try { found.push(JSON.parse(json.slice(from, i + 1))); } catch { /* not plain JSON */ }
    }
  }
  return found;
}

const isSunoUrl = (value) => {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && isSunoHost(url.hostname);
};

/**
 * Suno keeps "Exclude styles" apart from the style tags. Fold them into the
 * style as minus-prefixed terms (Suno's own inline spelling) so the song's
 * style text carries what it avoids; a term already excluded inline is kept once.
 */
function withExcludedStyles(tags, negativeTags) {
  const dash = /^[-\u2010-\u2013\u2212]\s*/;
  const present = new Set(tags.split(',').map((t) => t.trim()).filter((t) => dash.test(t)).map((t) => t.replace(dash, '').toLowerCase()));
  const excluded = negativeTags.split(',').map((t) => t.trim().replace(dash, '')).filter((t) => t && !present.has(t.toLowerCase()));
  return [tags, ...excluded.map((t) => `-${t}`)].filter(Boolean).join(', ');
}

/**
 * Read what a Suno song page says about `songId`. Every field is best effort:
 * '' (or null for a URL) when the page doesn't carry it, so a page Suno
 * restyles still imports the audio. URLs are kept only when they point at Suno.
 */
export function parseSunoSongPage(html, songId) {
  const page = typeof html === 'string' ? html : '';
  const id = String(songId || '').toLowerCase();
  const { json, texts } = splitTextRows(id ? flightPayload(page) : '');
  // The song can be listed more than once (its record, the playbar); the full
  // record is the one carrying `metadata`.
  const records = json ? objectsWithId(json, id) : [];
  const song = records.find((r) => r?.metadata && typeof r.metadata === 'object') || records[0] || {};
  const text = (value) => {
    if (typeof value !== 'string') return '';
    const ref = /^\$([0-9a-f]+)$/i.exec(value)?.[1];
    return (ref ? texts.get(ref.toLowerCase()) ?? '' : value).trim();
  };
  const title = text(song.title) || metaContent(page, 'og:title').replace(/\s*\|\s*Suno\s*$/i, '').trim();
  const audioUrl = [song.audio_url, metaContent(page, 'og:audio')].find(isSunoCdnUrl) || null;
  const imageUrl = [song.image_large_url, song.image_url, metaContent(page, 'og:image')].find(isSunoUrl) || null;
  return {
    title,
    lyrics: text(song.metadata?.prompt),
    style: withExcludedStyles(text(song.metadata?.tags), text(song.metadata?.negative_tags)),
    // Whether the page said anything about excluded styles. An anonymous page
    // can leave the field out, which is not the same as a song excluding none.
    excludedStylesKnown: typeof song.metadata?.negative_tags === 'string',
    audioUrl,
    imageUrl,
  };
}
