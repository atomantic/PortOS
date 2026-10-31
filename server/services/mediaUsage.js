/**
 * Where each gallery image and video is used: music video shots, storyboards,
 * Casting / Environments / Objects records, universes, mood boards and every
 * other creative record that names a media file.
 *
 * The index is keyed like Media History cards (`image:<filename>`,
 * `video:<historyId>`). Each record's JSON is walked for strings that name a
 * media file (a bare filename, an app path such as `/data/images/<file>`, a
 * `<kind>:<ref>` media key or a video history id), so a new field holding a
 * file is covered without registering it here. Snapshot and pool fields
 * (unused takes, revisions, histories) are not uses and are skipped.
 *
 * Built on demand and cached until a source table or file changes (a cheap
 * count/updated_at fingerprint), so repeat reads cost one small query.
 */
import { join } from 'path';
import { stat } from 'fs/promises';
import { query } from '../lib/db.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { threadRefUrl } from '../lib/threadRefKinds.js';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|heic)$/i;
// Fields that hold candidates, snapshots or logs rather than what a record uses
// now: a music video's take pool and asset marks, revision and history arrays.
const SKIP_KEYS = new Set(['takes', 'assetMarks', 'revisions', 'songRevisionHistory', 'audioTimingRevisions',
  'history', 'removedItems', 'rejected', 'rejectedTakes', 'previous', 'undo', 'redo',
  // A music video's last-render inputs and review evidence describe a past render, not the board.
  'renderDependencies', 'renderResume', 'productionReview']);
const MAX_DEPTH = 40;
const MAX_STRING = 1024;

const enc = encodeURIComponent;
const urlFor = (kind, path) => (id) => threadRefUrl(kind, id) || path;

const scenesShot = (path, data, id) => {
  if (path[0] !== 'scenes' || typeof path[1] !== 'number') return null;
  const scene = data.scenes?.[path[1]];
  const sceneId = typeof scene?.sceneId === 'string' ? scene.sceneId : null;
  return { role: `Shot ${path[1] + 1}`, href: sceneId ? `/music-video/${enc(id)}/scene/${enc(sceneId)}` : null };
};

const storyboardPanel = (path, data, id) => {
  if (path[0] !== 'beats' || path[2] !== 'panels' || typeof path[3] !== 'number') return null;
  const panel = data.beats?.[path[1]]?.panels?.[path[3]];
  const n = (data.beats || []).slice(0, path[1]).reduce((sum, beat) => sum + (beat?.panels?.length || 0), 0) + path[3] + 1;
  return { role: `Panel ${n}`, href: typeof panel?.id === 'string' ? `/storyboards/${enc(id)}/panel/${enc(panel.id)}` : null };
};

const musicVideoRole = (path, data, id) => {
  if (path[0] === 'renderHistoryId' || path[0] === 'renderPartialFilename') return { role: 'Final render' };
  if (path[0] === 'publishKit') return { role: 'Publish kit' };
  if (path[0] === 'castAndSets') return { role: 'Cast & sets' };
  return scenesShot(path, data, id);
};

/**
 * Postgres sources: `sql` returns `{ id, title, data }` for live rows; `fingerprint`
 * returns one text that changes whenever a live row is added, changed or removed.
 */
const table = (name, { titleSql = 'name', dataSql = 'data', liveSql = 'deleted = FALSE', updatedSql = 'updated_at' } = {}) => ({
  sql: `SELECT id::text AS id, ${titleSql} AS title, ${dataSql} AS data FROM ${name} WHERE ${liveSql}`,
  fingerprint: `SELECT count(*) || ':' || COALESCE(max(${updatedSql})::text, '') FROM ${name} WHERE ${liveSql}`,
});

const USAGE_SOURCES = Object.freeze([
  { source: 'music-video', label: 'Music video', ...table('music_video_projects', { titleSql: "NULLIF(data->>'name', '')" }),
    href: (id) => `/music-video/${enc(id)}`, locate: musicVideoRole },
  { source: 'storyboard', label: 'Storyboard', ...table('storyboards'), href: urlFor('storyboard', '/storyboards'), locate: storyboardPanel },
  { source: 'universe', label: 'Universe', ...table('universes'), href: urlFor('universe', '/universes') },
  { source: 'mood-board', label: 'Mood board', ...table('mood_boards'), href: (id) => `/mood-boards/${enc(id)}` },
  { source: 'fableloom', label: 'FableLoom', ...table('fableloom_stories'), href: urlFor('fableloom', '/fableloom') },
  { source: 'creative-director', label: 'Creative Director', ...table('creative_director_projects', { titleSql: "NULLIF(data->>'title', '')" }),
    href: urlFor('creative-director', '/creative-director') },
  { source: 'series', label: 'Series', ...table('pipeline_series'), href: urlFor('series', '/pipeline') },
  { source: 'issue', label: 'Issue', ...table('pipeline_issues', { titleSql: "NULLIF(data->>'title', '')" }), href: urlFor('issue', '/pipeline') },
  { source: 'sprite', label: 'Sprite', ...table('sprite_records', { titleSql: "NULLIF(data->>'name', '')" }), href: (id) => `/sprites/${enc(id)}` },
  { source: 'code-animation', label: 'Code animation', ...table('code_animation_projects', { titleSql: 'title', liveSql: 'TRUE' }),
    href: (id) => `/code-animation/production/${enc(id)}` },
  { source: 'deck', label: 'Deck', ...table('decks', { dataSql: 'definition' }), href: (id) => `/decks/${enc(id)}` },
  { source: 'creative-commission', label: 'Commission', ...table('creative_commissions'), href: (id) => `/creative-commission/${enc(id)}` },
  { source: 'catalog', label: 'Catalog', ...table('catalog_ingredients', { titleSql: 'name', dataSql: "jsonb_build_object('type', type, 'payload', payload)" }),
    href: () => null, catalog: true },
]);

const CATALOG_LIBRARIES = { character: ['/casting', 'Casting'], place: ['/environments', 'Environment'], object: ['/objects', 'Object'] };

/** A catalog media row's tab on its record page and the role shown for it. */
function catalogMediaPlace(type, kind, role) {
  const r = typeof role === 'string' ? role : '';
  if (r.startsWith('sheet:')) return { tab: 'sheets', role: 'Sheet' };
  if (r.startsWith('look:')) return { tab: 'looks', role: 'Look' };
  if (r === 'plate') return { tab: 'plates', role: 'Plate' };
  if (r.startsWith('design:')) return { tab: 'design', role: 'Design take' };
  if (r.startsWith('greybox-shot:')) return { tab: 'greybox', role: 'Greybox shot' };
  if (kind === 'portrait') return { tab: null, role: 'Portrait' };
  return { tab: type === 'object' ? 'images' : 'references', role: kind === 'video' ? 'Video' : 'Reference' };
}

function catalogHref(type, id, tab) {
  const lib = CATALOG_LIBRARIES[type];
  if (!lib) return `/catalog/${enc(type || 'idea')}/${enc(id)}`;
  return `${lib[0]}/${enc(id)}${tab ? `/${tab}` : ''}`;
}

const catalogLabel = (type) => CATALOG_LIBRARIES[type]?.[1] || 'Catalog';

/**
 * The media key a string names, or null: `image:<file>` for an image filename or
 * app path, `video:<id>` for a video history id, filename, app path or key.
 * Thumbnails and outside URLs are not the file itself.
 */
function mediaKeyOf(value, videos) {
  if (typeof value !== 'string' || !value || value.length > MAX_STRING || /\s/.test(value)) return null;
  const keyed = /^(image|video):([^/:]+)$/.exec(value);
  if (keyed) {
    if (keyed[1] === 'image') return IMAGE_EXT.test(keyed[2]) ? value : null;
    const id = videos.ids.has(keyed[2]) ? keyed[2] : videos.byFilename.get(keyed[2]);
    return id ? `video:${id}` : null;
  }
  if (videos.ids.has(value)) return `video:${value}`;
  let path = value.split(/[?#]/)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    const at = path.search(/\/data\/(images|videos)\//);
    if (at < 0) return null;
    path = path.slice(at);
  }
  if (/thumbnail/i.test(path)) return null;
  let base = path.slice(path.lastIndexOf('/') + 1);
  try { base = decodeURIComponent(base); } catch { return null; }
  if (!base || base.startsWith('.')) return null;
  const videoId = videos.byFilename.get(base);
  if (videoId) return `video:${videoId}`;
  return IMAGE_EXT.test(base) ? `image:${base}` : null;
}

/** Every media key a record's JSON names, with the path it was found at. */
function collectMediaRefs(data, videos) {
  const found = [];
  const walk = (value, path) => {
    if (path.length > MAX_DEPTH || value == null) return;
    if (typeof value === 'string') {
      const key = mediaKeyOf(value, videos);
      if (key) found.push({ key, path });
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child, i) => walk(child, [...path, i]));
      return;
    }
    for (const [k, child] of Object.entries(value)) {
      if (!SKIP_KEYS.has(k)) walk(child, [...path, k]);
    }
  };
  walk(data, []);
  return found;
}

async function videoLookup() {
  const { loadHistory } = await import('./videoGen/history.js');
  const history = await loadHistory();
  const ids = new Set();
  const byFilename = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    ids.add(entry.id);
    if (typeof entry.filename === 'string' && entry.filename) byFilename.set(entry.filename, entry.id);
  }
  return { ids, byFilename };
}

const parseData = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};

const fileStamp = (file) => stat(file).then((s) => `${s.size}:${s.mtimeMs}`, () => 'none');
const VIDEO_HISTORY_FILE = () => join(PATHS.data, 'video-history.json');
const VIDEO_PROJECTS_FILE = () => join(PATHS.data, 'video-projects.json');
const CATALOG_MEDIA_FINGERPRINT = `SELECT count(*) || ':' || COALESCE(max(updated_at)::text, '') FROM catalog_ingredient_media WHERE deleted = FALSE`;

async function fingerprint() {
  const sql = [...USAGE_SOURCES.map((s) => s.fingerprint), CATALOG_MEDIA_FINGERPRINT]
    .map((q, i) => `SELECT ${i} AS i, (${q}) AS f`).join(' UNION ALL ');
  const [{ rows }, history, projects] = await Promise.all([query(sql), fileStamp(VIDEO_HISTORY_FILE()), fileStamp(VIDEO_PROJECTS_FILE())]);
  return JSON.stringify([rows.sort((a, b) => a.i - b.i).map((r) => r.f), history, projects]);
}

function addUsage(index, seen, key, usage) {
  const dedupe = JSON.stringify([key, usage.source, usage.id, usage.role || '']);
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  (index[key] ||= []).push(usage);
}

async function buildIndex() {
  const videos = await videoLookup();
  const index = {};
  const seen = new Set();
  for (const spec of USAGE_SOURCES) {
    const { rows } = await query(spec.sql);
    for (const row of rows) {
      const data = parseData(row.data);
      if (!data || typeof data !== 'object') continue;
      const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null;
      for (const { key, path } of collectMediaRefs(data, videos)) {
        if (spec.catalog) {
          addUsage(index, seen, key, { source: 'catalog', label: catalogLabel(data.type), id: row.id, title, role: null, href: catalogHref(data.type, row.id, null) });
          continue;
        }
        const place = spec.locate?.(path, data, row.id) || {};
        addUsage(index, seen, key, {
          source: spec.source, label: spec.label, id: row.id, title,
          role: place.role || null, href: place.href || spec.href(row.id),
        });
      }
    }
  }
  // Attached Casting / Environments / Objects media, reported on the canonical
  // (merged) record so a merge never shows the same person twice.
  const { rows: media } = await query(`SELECT m.media_key, m.kind, m.role, i.id, i.name, i.type
    FROM catalog_ingredient_media m
    JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(m.ingredient_id)
    WHERE m.deleted = FALSE AND i.deleted = FALSE`);
  for (const row of media) {
    const key = mediaKeyOf(row.media_key, videos);
    if (!key) continue;
    const place = catalogMediaPlace(row.type, row.kind, row.role);
    addUsage(index, seen, key, {
      source: 'catalog', label: catalogLabel(row.type), id: row.id, title: row.name || null,
      role: place.role, href: catalogHref(row.type, row.id, place.tab),
    });
  }
  const { listProjects } = await import('./videoTimeline/local.js');
  for (const project of await listProjects()) {
    if (typeof project?.id !== 'string') continue;
    for (const { key } of collectMediaRefs(project, videos)) {
      addUsage(index, seen, key, {
        source: 'video-timeline', label: 'Timeline', id: project.id, title: project.name || null,
        role: null, href: `/media/timeline/${enc(project.id)}`,
      });
    }
  }
  return index;
}

let cached = null;
let building = null;

/** `{ '<kind>:<ref>': [{ source, label, id, title, role, href }] }` for every used media file. */
export async function getMediaUsageIndex() {
  // The file backend and test runners have no Postgres to scan (the same
  // escape hatch as mediaAssetIndex), so nothing reads as used there.
  if (process.env.MEMORY_BACKEND === 'file' || isTestRunner()) return {};
  const stamp = await fingerprint();
  if (cached?.stamp === stamp) return cached.index;
  if (building?.stamp === stamp) return building.promise;
  const promise = buildIndex().then((index) => {
    cached = { stamp, index };
    return index;
  }).finally(() => {
    if (building?.promise === promise) building = null;
  });
  building = { stamp, promise };
  return promise;
}

/** The records using one media file (`image:<filename>` / `video:<id>`). */
export async function getMediaUsages(key) {
  return (await getMediaUsageIndex())[key] || [];
}

const describe = (u) => [u.title ? `${u.label} "${u.title}"` : u.label, u.role].filter(Boolean).join(' ');

/**
 * Refuse to delete a file something still uses, unless the caller overrides.
 * 409 `MEDIA_IN_USE` carries the usages so the UI can list them.
 */
export async function assertMediaDeletable(key, { force = false } = {}) {
  if (force) return;
  const usages = await getMediaUsages(key);
  if (!usages.length) return;
  const named = usages.slice(0, 3).map(describe).join(', ');
  const more = usages.length > 3 ? ` and ${usages.length - 3} more` : '';
  throw new ServerError(`In use by ${named}${more}. Swap it out there first, or use Delete anyway.`, {
    status: 409, code: 'MEDIA_IN_USE', context: { usages },
  });
}
