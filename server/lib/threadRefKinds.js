/**
 * Thread ref VOCABULARY — the one `(kind, id)` → label/route table (#7664).
 *
 * A Brain *thread* is a tracked topic or commitment (an open loop in the bullet
 * journal sense) — NOT a message thread. `messageSync.js` / `messageGmailSync.js`
 * / `beeperSync.js` own that other sense of the word; nothing here touches it.
 *
 * A thread carries `refs: [{ kind, id, label? }]` pointing at the PortOS records
 * and external items that belong to it. This module is the single source of
 * truth for WHICH kinds exist and WHERE each one deep-links to — add a row here
 * and `server/services/threadRefs.js` must gain a matching resolver (a drift
 * guard fails CI otherwise).
 *
 * Deliberately PURE — no db, no services, no zod. `server/lib` may not import
 * upward into `server/services` (see lib/taskTargetScope.js), and the client
 * re-exports this leaf (`client/src/lib/threadRefKinds.js`) so the catalog
 * ingredient page renders its inbound-ref chips through the SAME table instead
 * of its own local switch. Existence/title lookups — everything that needs a
 * store — live in the service.
 *
 * Shape of a row:
 *   label          human name for the chip / group heading
 *   external       true = the id IS an off-PortOS URL; no local target to probe
 *   navPath        the NAV_COMMANDS page this kind lands on (guard-checked)
 *   basePath       URL prefix for a per-record deep link (defaults to navPath;
 *                  must start with navPath so the link stays on that page)
 *   segment        true = append `/<id>` to basePath
 *   suffix         appended after the id segment (e.g. an issue's default stage)
 *   param          append `?<param>=<id>` instead of a path segment
 *   contextSegment a context key inserted as a path segment BEFORE the id
 *                  (catalog ingredients live at /catalog/:type/:id, and the type
 *                  is only known once the record is resolved)
 *
 * A kind with none of segment/param/contextSegment deep-links to its page only —
 * that page has no per-record route yet. That is the pre-existing behavior of
 * the catalog page's `writers-room` arm, kept rather than invented.
 */

export const THREAD_REF_KINDS = Object.freeze({
  // ─── Brain records ───────────────────────────────────────────────────────
  // Most Brain tabs keep their selection in local state rather than the URL, so
  // there is no per-record route to point at yet; those land on the tab. The
  // Daily Log is the exception — it is date-addressed (`?date=`), and a journal
  // record's id IS its date key (brainJournal keys entries by date).
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

  // ─── App-native creative records ─────────────────────────────────────────
  // These five are the vocabulary `catalog_ingredient_refs` already stores
  // (server/services/catalogRefResolver.js REF_TARGET_TABLES). Their routes
  // moved here from the hard-coded switch in client/src/pages/CatalogIngredient.jsx
  // so there is exactly one kind→route table in the repo.
  universe: { label: 'Universes', external: false, navPath: '/universes', segment: true },
  series: { label: 'Series', external: false, navPath: '/pipeline', basePath: '/pipeline/series', segment: true },
  issue: { label: 'Issues', external: false, navPath: '/pipeline', basePath: '/pipeline/issues', segment: true, suffix: '/concept' },
  'creative-director': { label: 'Creative Director', external: false, navPath: '/creative-director', segment: true, suffix: '/overview' },
  'writers-room': { label: "Writers' Room", external: false, navPath: '/writers-room' },

  // ─── Other PortOS records ────────────────────────────────────────────────
  goal: { label: 'Goal', external: false, navPath: '/goals/list', segment: true },
  app: { label: 'App', external: false, navPath: '/apps', segment: true },
  message: { label: 'Message', external: false, navPath: '/messages/inbox' },
  'cos.task': { label: 'Task', external: false, navPath: '/cos/tasks' },

  // ─── External items ──────────────────────────────────────────────────────
  // The id IS the canonical URL, so it is self-describing across machines and
  // needs no local lookup. `threadRefUrl` scheme-guards it before it can become
  // an href (see below).
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

// Legacy spellings a stored ref (or a catalog ref row written before the
// vocabulary settled) can still carry. Resolved to the canonical kind on read
// so an old record keeps rendering; nothing WRITES these.
const KIND_ALIASES = Object.freeze({
  writersRoom: 'writers-room',
});

/**
 * The canonical kind id for a possibly-aliased spelling, or the input unchanged.
 * Never throws — an unknown kind stays unknown so the caller can degrade it.
 */
export function canonicalThreadRefKind(kind) {
  if (typeof kind !== 'string') return kind;
  return KIND_ALIASES[kind] || kind;
}

/**
 * Display label for a kind. An unrecognized kind (a peer on newer code can sync
 * one) renders as its own id rather than throwing or reading as empty.
 */
export function threadRefLabel(kind) {
  const canonical = canonicalThreadRefKind(kind);
  return THREAD_REF_KINDS[canonical]?.label || (typeof kind === 'string' ? kind : '');
}

// Only these schemes may become an href. A stored ref is user- OR peer-supplied
// text, so `javascript:`/`data:` must never reach the DOM as a link.
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Is this a link-safe absolute URL? Exported because both the URL builder and
 * the write-schema guard need the same answer.
 */
export function isSafeExternalUrl(value) {
  // `canParse` is false for anything that isn't ABSOLUTE, which is the right
  // answer here: a relative string is not a usable external ref.
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  return SAFE_EXTERNAL_SCHEMES.has(new URL(value).protocol);
}

/**
 * The click-through URL for one ref, or `null` when this build can't build one
 * (unknown kind, missing id, or an external id that isn't a safe http(s) URL).
 * Callers render the chip without a link on null — the pre-existing contract of
 * the catalog page's `refPath`.
 *
 * `context` supplies the extra segment a kind declares via `contextSegment`
 * (currently only a catalog ingredient's `catalogType`, which is known only once
 * the record has been looked up). Without it the link degrades to the kind's
 * page rather than producing a route that would 404.
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
    // No context yet (an unresolved or not-yet-hydrated ref) — land on the page
    // rather than emitting `/catalog/undefined/<id>`.
    if (typeof extra !== 'string' || !extra) return basePath;
    return `${basePath}/${encodeURIComponent(extra)}/${encodeURIComponent(id)}${spec.suffix || ''}`;
  }
  return `${basePath}/${encodeURIComponent(id)}${spec.suffix || ''}`;
}
