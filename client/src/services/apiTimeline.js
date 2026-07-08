import { request } from './apiCore.js';

// Human-activity timeline (#2150). Day view + filtered event list.

export const getTimelineDay = (options = {}) => {
  const params = new URLSearchParams();
  if (options.date) params.set('date', options.date);
  const qs = params.toString();
  return request(`/timeline/day${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

export const getTimelineEvents = (options = {}) => {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.source) params.set('source', options.source);
  if (options.kind) params.set('kind', options.kind);
  if (options.personId) params.set('personId', options.personId);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/timeline/events${qs ? `?${qs}` : ''}`, { silent: options.silent });
};

// Bulk-backfill importers (#2160). Upload an export file (ZIP or single JSON).
// `preview: true` returns parse-only counts + a summary without writing; a real
// import is idempotent so re-imports are safe. request() detects the FormData
// body and lets the browser set the boundary.
const importFile = (path, file, { preview = false, fields = {}, ...options } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('preview', preview ? 'true' : 'false');
  // Source-specific extra text fields (e.g. WhatsApp's `yourName`). Blank values
  // are dropped so the server sees "not provided" rather than an empty string.
  for (const [name, value] of Object.entries(fields)) {
    if (value != null && String(value).trim() !== '') formData.append(name, String(value));
  }
  return request(path, { method: 'POST', body: formData, ...options });
};

// Spotify extended-history export (dedupe on played-at + track).
export const importSpotifyHistory = (file, options = {}) =>
  importFile('/timeline/import/spotify', file, options);

// Google Takeout "Location History (Timeline)" semantic place visits (dedupe on
// visit-start + place identity).
export const importTakeoutLocationHistory = (file, options = {}) =>
  importFile('/timeline/import/takeout-location', file, options);

// Discord "data package" — the messages you sent across every channel/DM
// (dedupe on the globally-unique Discord message snowflake id).
export const importDiscordHistory = (file, options = {}) =>
  importFile('/timeline/import/discord', file, options);

// WhatsApp "Export chat" transcript (`_chat.txt`, standalone or zipped) — each
// message becomes a timeline event (dedupe on a content hash). An optional
// `yourName` classifies direction: a sender matching it → sent, others →
// received; absent → neutral `message` events. An optional `chatLabel` is a stable
// chat name that scopes the dedupe key so distinct chats don't collide.
export const importWhatsappHistory = (file, { yourName, chatLabel, ...options } = {}) =>
  importFile('/timeline/import/whatsapp', file, { ...options, fields: { yourName, chatLabel } });

// Google Takeout Chrome browser history (`History.json`, standalone or zipped) —
// each visit becomes a `web.visit` event (dedupe on a content hash of
// visit-instant + URL). Subframe (iframe) loads are dropped server-side.
export const importBrowserHistory = (file, options = {}) =>
  importFile('/timeline/import/browser', file, options);
