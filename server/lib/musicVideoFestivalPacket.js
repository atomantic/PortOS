import { z } from 'zod';

export const FESTIVAL_FIELDS = [
  ['title', 'Title', 'Film'], ['completion', 'Completion date or year', 'Film'],
  ['runtime', 'Declared runtime', 'Film'], ['language', 'Language', 'Film'], ['format', 'Format', 'Film'],
  ['screener', 'Public screener or render URL', 'Assets'], ['poster', 'Public poster URL', 'Assets'],
  ['still', 'Public representative still URL', 'Assets'], ['captions', 'Public captions URL', 'Assets'],
  ['director', 'Director', 'Credits'], ['producer', 'Producer', 'Credits'], ['writer', 'Writer', 'Credits'],
  ['music', 'Music credits', 'Credits'], ['collaborators', 'Other collaborators', 'Credits'],
  ['shortSynopsis', 'Short synopsis', 'Descriptions'], ['longSynopsis', 'Long synopsis', 'Descriptions'],
  ['biography', 'Director biography', 'Descriptions'], ['aiStatement', 'AI process statement', 'AI and rights'],
  ['tools', 'AI tools and models', 'AI and rights'], ['rightsNotes', 'Rights notes', 'AI and rights'],
  ['musicRightsNotes', 'Music rights notes', 'AI and rights'], ['consentNotes', 'Likeness and consent notes', 'AI and rights'],
  ['releases', 'Public releases (URLs and dates)', 'History'], ['entries', 'Previous festival entries', 'History'],
  ['screenings', 'Previous screenings', 'History'], ['premiere', 'Premiere status (your declaration)', 'History'],
].map(([id, label, group]) => ({ id, label, group }));
export const FESTIVAL_NOTE_FIELDS = [
  ['name', 'Festival name'], ['url', 'Festival URL'], ['category', 'Intended category'],
  ['deadline', 'Deadline'], ['fee', 'Fee (amount and currency only)'], ['requirements', 'Special requirements'],
  ['questions', 'Additional questions and answers'],
].map(([id, label]) => ({ id, label }));
export const FESTIVAL_RIGHTS = ['rights', 'musicRights', 'consent'];
export const FESTIVAL_RIGHTS_LABELS = { rights: 'Rights status', musicRights: 'Music rights status', consent: 'Likeness / consent status' };
const URL_FIELDS = new Set(['screener', 'poster', 'still', 'captions']);

// A packet is deliberately portable text. Reject private references rather than
// silently rewriting creative input or allowing them into the peer/export path.
export function festivalPublicUrl(value) {
  const parsed = z.string().url().safeParse(value);
  if (!parsed.success) return false;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|ts\.net)$/.test(host)
    && [...url.searchParams.keys()].every(key => key === 'v');
}
export function festivalSafeText(value) {
  if (/\b(?:password|passcode|api[ _-]?key|secret|token|authorization|cookie|card[ _-]?number|cvv)\s*[:=]|\bBearer\s+|\b(?:sk-|ghp_|github_pat_)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(value)) return false;
  if (/(?:^|[\s('"=])(?:[a-z]:[\\/]|~[\\/]|\/(?!\/))\S|\\\\|\b(?:file|data|smb|ssh):|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w.-]+\.(?:local|internal|lan|home|ts\.net)\b|\blocalhost\b/i.test(value)) return false;
  const links = value.match(/(?:[a-z]+:\/\/|\/\/)[^\s<>"')]+/gi) || [];
  return links.every(festivalPublicUrl);
}
const safeText = z.string().max(12000).refine(festivalSafeText, 'Remove credentials, payment details and private paths or network references. Use public HTTPS links without access tokens.');
const fields = Object.fromEntries(FESTIVAL_FIELDS.map(({ id }) => [id, URL_FIELDS.has(id)
  ? safeText.refine(value => !value || festivalPublicUrl(value), 'Use a public HTTPS URL without credentials or access tokens.').optional()
  : safeText.optional()]));
export const festivalPacketSchema = z.object({
  version: z.literal(1),
  fields: z.object(fields).strict(),
  rights: z.enum(['unknown', 'confirmed', 'not-cleared']).default('unknown'),
  musicRights: z.enum(['unknown', 'confirmed', 'not-cleared']).default('unknown'),
  consent: z.enum(['unknown', 'confirmed', 'not-cleared']).default('unknown'),
  festivals: z.array(z.object({
    ...Object.fromEntries(FESTIVAL_NOTE_FIELDS.map(({ id }) => [id, id === 'url'
      ? safeText.refine(value => !value || festivalPublicUrl(value), 'Use a public HTTPS URL.').default('') : safeText.default('')])),
    include: z.boolean().default(false),
  }).strict()).max(50).default([]),
  include: z.array(z.enum([...FESTIVAL_FIELDS.map(field => field.id), ...FESTIVAL_RIGHTS, 'measurements'])).max(40).default([]),
}).strict();
export const emptyFestivalPacket = () => festivalPacketSchema.parse({ version: 1, fields: {} });

export function festivalPacketText(packet, measurements) {
  const selected = new Set(packet.include);
  const lines = ['Festival submission packet', '', 'Prepared information only. Eligibility is unverified; rights and premiere declarations require independent review.'];
  for (const { id, label } of FESTIVAL_FIELDS) {
    if (selected.has(id)) lines.push('', `${label}:`, packet.fields[id]?.trim() || 'Unknown — not provided');
  }
  for (const id of FESTIVAL_RIGHTS) if (selected.has(id)) lines.push('', `${FESTIVAL_RIGHTS_LABELS[id]}: ${packet[id]} (user declaration)`);
  if (selected.has('measurements')) lines.push('', 'Current final render measurements:', measurements.status === 'current'
    ? `${measurements.width} × ${measurements.height} pixels; ${measurements.durationSec} seconds (measured at preview)`
    : 'Unknown — current final render unavailable or unverified');
  for (const festival of packet.festivals.filter(item => item.include)) {
    lines.push('', 'Festival notes — eligibility unverified');
    for (const { id, label } of FESTIVAL_NOTE_FIELDS) lines.push(`${label}: ${festival[id]?.trim() || 'Unknown — not provided'}`);
  }
  return `${lines.join('\n')}\n`;
}
