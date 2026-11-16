/**
  * Thread ref VOCABULARY: the one `(kind, id)` → label/route table (#7664).
  *
  * A Brain *thread* is a tracked topic or commitment (an open loop), NOT a message thread (`messageSync.js` / `messageGmailSync.js` / `beeperSync.js`). It carries `refs: [{ kind, id, label? }]` pointing at PortOS records and external items; this is the single source of truth for WHICH kinds exist and WHERE each deep-links (add a row and `server/services/threadRefs.js` must gain a resolver: a drift guard fails CI). Deliberately PURE (no db, services or zod: `server/lib` may not import upward, see lib/taskTargetScope.js); the client re-exports it (`client/src/lib/threadRefKinds.js`) so the catalog ingredient page's inbound-ref chips use the SAME table. Existence/title lookups live in the service. Row shape: `label` (chip/group heading); `external` (id IS an off-PortOS URL, nothing to probe); `navPath` (the guard-checked NAV_COMMANDS page); `basePath` (per-record deep-link prefix, defaults to navPath and must start with it); `segment` (append `/<id>`); `suffix` (after the id segment, e.g. an issue's default stage); `param` (append `?<param>=<id>`); `contextSegment` (context key inserted BEFORE the id: catalog ingredients live at /catalog/:type/:id, type known only once resolved). A kind with none of segment/param/contextSegment deep-links to its page only (no per-record route yet; the catalog page's `writers-room` arm behavior, kept).
 */

export const THREAD_REF_KINDS = Object.freeze({
  // ─── Brain records ─── Most Brain tabs keep selection in local state, not the URL, so those land on the tab; the Daily Log is date-addressed (`?date=`) and a journal record's id IS its date key (brainJournal).
  'brain.idea': { label: 'Idea', external: false, navPath: '/brain/ideas' },
  'brain.project': { label: 'Project', external: false, navPath: '/brain/memory' },
  'brain.person': { label: 'Person', external: false, navPath: '/brain/memory' },
  'brain.admin': { label: 'Admin', external: false, navPath: '/brain/memory' },
  'brain.memory': { label: 'Memory', external: false, navPath: '/brain/memory' },
  'brain.link': { label: 'Link', external: false, navPath: '/brain/links' },
  'brain.journal': { label: 'Journal', external: false, navPath: '/brain/daily-log', param: 'date' },
  'brain.song': { label: 'Song', external: false, navPath: '/songbook', segment: true },

  // ─── Creative catalog ────────────────────────────────────────────────────
  'catalog.scrap': { label: 'Scrap', external: false, navPath: '/catalog/ingest' },
  'catalog.ingredient': {
    label: 'Ingredient',
    external: false,
    navPath: '/catalog',
    segment: true,
    contextSegment: 'catalogType',
  },

  // ─── App-native creative records ─── the vocabulary `catalog_ingredient_refs` stores (server/services/catalogRefResolver.js REF_TARGET_TABLES); routes moved here from client/src/pages/CatalogIngredient.jsx so there is one kind→route table.
  universe: { label: 'Universes', external: false, navPath: '/universes', segment: true },
  series: { label: 'Series', external: false, navPath: '/pipeline', basePath: '/pipeline/series', segment: true },
  issue: { label: 'Issues', external: false, navPath: '/pipeline', basePath: '/pipeline/issues', segment: true, suffix: '/concept' },
  'creative-director': { label: 'Creative Director', external: false, navPath: '/creative-director', segment: true, suffix: '/overview' },
  'music-video': { label: 'Music Videos', external: false, navPath: '/music-video', segment: true },
  'writers-room': { label: "Writers' Room", external: false, navPath: '/writers-room' },
  work: { label: 'Works', external: false, navPath: '/writers-room', basePath: '/writers-room/works', segment: true },
  fableloom: { label: 'FableLoom', external: false, navPath: '/fableloom', segment: true },
  storyboard: { label: 'Storyboards', external: false, navPath: '/storyboards', segment: true },
  'voice-profile': { label: 'Voice Studio', external: false, navPath: '/voices', segment: true },

  // ─── Other PortOS records ────────────────────────────────────────────────
  goal: { label: 'Goal', external: false, navPath: '/goals/list', segment: true },
  app: { label: 'App', external: false, navPath: '/apps', segment: true },
  message: { label: 'Message', external: false, navPath: '/messages/inbox' },
  'cos.task': { label: 'Task', external: false, navPath: '/cos/tasks' },

  // ─── External items ─── the id IS the canonical URL (self-describing across machines, no lookup); `threadRefUrl` scheme-guards it before it becomes an href.
  'github.issue': { label: 'GitHub issue', external: true },
  'gitlab.issue': { label: 'GitLab issue', external: true },
  'jira.issue': { label: 'JIRA issue', external: true },
  url: { label: 'Link', external: true },
});

/** Every kind this build knows about. */
export const THREAD_REF_KIND_IDS = Object.freeze(Object.keys(THREAD_REF_KINDS));

/** The kinds whose target lives in this install (a resolver must exist). */
export const INTERNAL_THREAD_REF_KINDS = Object.freeze(
  THREAD_REF_KIND_IDS.filter((kind) => !THREAD_REF_KINDS[kind].external),
);

/** The kinds whose id is an off-PortOS URL. */
export const EXTERNAL_THREAD_REF_KINDS = Object.freeze(
  THREAD_REF_KIND_IDS.filter((kind) => THREAD_REF_KINDS[kind].external),
);

// Legacy spellings a stored ref (or a catalog ref row from before the vocabulary settled) can carry; resolved to the canonical kind on read so old records render; nothing WRITES these.
const KIND_ALIASES = Object.freeze({
  writersRoom: 'writers-room',
});

/** The canonical kind id for a possibly-aliased spelling, or the input unchanged; never throws (an unknown kind stays unknown so the caller can degrade it). */
export function canonicalThreadRefKind(kind) {
  if (typeof kind !== 'string') return kind;
  return KIND_ALIASES[kind] || kind;
}

/** Display label for a kind; an unrecognized kind (a newer peer can sync one) renders as its own id rather than throwing or empty. */
export function threadRefLabel(kind) {
  const canonical = canonicalThreadRefKind(kind);
  return THREAD_REF_KINDS[canonical]?.label || (typeof kind === 'string' ? kind : '');
}

// Only these schemes may become an href: a stored ref is user- OR peer-supplied, so `javascript:`/`data:` must never reach the DOM as a link.
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:']);

/** Is this a link-safe absolute URL? Exported because the URL builder and the write-schema guard need the same answer. */
export function isSafeExternalUrl(value) {
  // `canParse` is false for anything not ABSOLUTE, which is right: a relative string isn't a usable external ref.
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  return SAFE_EXTERNAL_SCHEMES.has(new URL(value).protocol);
}

/**
 * The click-through URL for one ref, or `null` when this build can't build one (unknown kind, missing id, or a non-http(s) external id); callers render the chip without a link on null. `context` supplies the extra segment a kind declares via
 * `contextSegment` (a catalog ingredient's `catalogType`, known only after lookup); without it the link degrades to the kind's page rather than a route that would 404.
 */
export function threadRefUrl(kind, id, context = {}) {
  const canonical = canonicalThreadRefKind(kind);
  const spec = THREAD_REF_KINDS[canonical];
  if (!spec || typeof id !== 'string' || !id) return null;

  if (spec.external) return isSafeExternalUrl(id) ? id : null;

  const basePath = spec.basePath || spec.navPath;
  if (spec.param) return `${basePath}?${spec.param}=${encodeURIComponent(id)}`;
  if (!spec.segment) return basePath;

  if (spec.contextSegment) {
    const extra = context?.[spec.contextSegment];
    // No context yet (unresolved or not-yet-hydrated ref): land on the page rather than emit `/catalog/undefined/<id>`.
    if (typeof extra !== 'string' || !extra) return basePath;
    return `${basePath}/${encodeURIComponent(extra)}/${encodeURIComponent(id)}${spec.suffix || ''}`;
  }
  return `${basePath}/${encodeURIComponent(id)}${spec.suffix || ''}`;
}
