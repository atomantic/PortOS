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
const importFile = (path, file, { preview = false, ...options } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('preview', preview ? 'true' : 'false');
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

// WhatsApp "Export chat" transcript (`_chat.txt`, standalone or zipped) — every
// message becomes a neutral timeline event (dedupe on a content hash).
export const importWhatsappHistory = (file, options = {}) =>
  importFile('/timeline/import/whatsapp', file, options);
