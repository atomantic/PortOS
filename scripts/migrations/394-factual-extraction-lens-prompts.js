/**
 * Give the four catalog-ingest extraction prompts a non-fiction lens (#7609).
 *
 * Pasting an autobiographical passage into Catalog Ingest used to come back as
 * generic role tags — `MOM`, `DAD`, `NARRATOR` — because the extractor never
 * told the prompts what they were reading. The fiction-shaped templates did
 * exactly what they were told: "for unnamed characters use a stable role tag
 * like THE BARTENDER", and "commit to a renderable detail when the prose is
 * silent", both of which are wrong for a memoir about real people.
 *
 * Each template gains a `{{#factual}}` section that suspends the invent-to-fill
 * rules, keeps a person named by relation as `Mom` rather than `MOM`, and lets
 * the physical fields stay empty. The light stage additionally gains a `## Source`
 * block carrying the scrap's own title and capture kind, which renders under
 * both lenses — the catalog path previously rendered every framing slot empty.
 *
 * Both blocks are mustache-gated, so an install extracting invented fiction
 * renders the same prompts it rendered before this migration. Hash replacement
 * preserves a user-customized template.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'writers-room-characters.md': ['4b19f6538ff3a602007ef8e32c8e5047'],
  'writers-room-places.md': ['a7f68e51dd6b4421d20f5bd9d855d9b4'],
  'writers-room-objects.md': ['1115d2d7d2e52e1e10c38325b88a4d94'],
  'catalog-ideas-scenes-concepts.md': ['98aa063cec8ad5c0e017dbc7bc949054'],
};

export const NEW_SHIPPED_MD5 = {
  'writers-room-characters.md': '73ec5bbfdad5c62ec5d5c30f0940febf',
  'writers-room-places.md': '5d323f7aea4c2658e7e29afae2bdb7a4',
  'writers-room-objects.md': '10efde7fbb46b28223db03f38e7043e4',
  'catalog-ideas-scenes-concepts.md': 'e6cce39c76689ea9c5233f233cd0f153',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Factual extraction lens prompts',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the\n` +
    '   "{{#factual}} / ## Lens: non-fiction" section (plus the {{#work.kind}}\n' +
    '   "## Source" block on catalog-ideas-scenes-concepts.md). Without it,\n' +
    '   factual ingest keeps extracting real people as fictional role tags.',
});

export { applyMigration };
export default { up };
