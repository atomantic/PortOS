// Routes whose main content owns its own internal scroll region and needs the
// bare full-width `<main>` (relative overflow-hidden) instead of the default
// padded+scrolling one. Checked in order: exact path, then prefix, then
// regex — see `isFullWidthRoute` below.
const EXACT_FULL_WIDTH_PATHS = [
  '/apps',
  '/stacker-news',
  '/x',
  '/privacy',
  '/code-animation',
  '/character',
  '/eidoverse',
  '/ai',
  // Data Manager is a bordered title bar over a `flex-1 overflow-auto` body,
  // so it owns its own scroll. EXACT, not a prefix — a `/data` prefix would
  // also swallow the `/datadog` redirect route.
  '/data',
  '/devtools/flows',
  '/ask',
  // OpenClaw lives under the Settings nav group; it's a full-bleed
  // chat surface (sidebar + message pane) that owns its own internal
  // scroll, so it needs the bare full-width main like the other
  // Full-width Settings pages (/prompts, /settings/*) and the Models Providers
  // page at /ai.
  '/openclaw',
  '/prompts',
  '/review',
  '/shell',
  // Tribe is a full-bleed two-pane page that owns its own internal
  // scroll (PageHeader + a `flex-1 overflow-auto` main); keep it out
  // of the default padded+scrolling main or it double-pads and clips.
  '/tribe',
  // Rapid Reader is a full-bleed brain sub-page: full-width PageHeader
  // over an internal `flex-1 overflow-auto` scroll region.
  '/rapid-reader',
  // Timeline (/timeline and /timeline/:date) is a full-bleed brain
  // sub-page: full-width PageHeader over an internal `flex-1
  // overflow-auto` scroll region that wraps the centered max-w-4xl
  // content — keep it out of the default padded main or it double-pads.
  '/timeline',
  // Create index pages share one PageHeader bar over a `flex-1 overflow-auto`
  // body (#10994). Exact entries are the indexes whose detail routes are a
  // different component (and already classified, or intentionally padded).
  '/catalog',
  '/universes',
  '/rounds',
  '/story-builder',
  '/pipeline',
  '/pipeline/editorial-checks',
  '/game',
  '/3d',
  '/decks',
  '/fableloom',
  '/mood-boards',
  '/creative-commission',
  '/creative-commission/new',
  '/importer',
  '/start-story',
];

const FULL_WIDTH_PATH_PREFIXES = [
  '/review/',
  '/rapid-reader/',
  '/stacker-news/',
  '/x/',
  '/privacy/',
  '/code-animation/',
  '/ask/',
  '/calendar',
  // Catalog detail (/catalog/{type}/{id}) and Ingest (/catalog/ingest)
  // own their scroll. The /catalog index is an EXACT full-width entry above.
  '/catalog/',
  '/cos',
  // Both the Creative Director index and its detail editor manage
  // their own internal scroll (flex-col h-full + overflow-auto body),
  // so they need the bare full-width main — same as when they lived
  // under the /media tabs.
  '/creative-director',
  '/brain',
  '/digital-twin',
  '/feature-agents',
  '/goals',
  '/insights',
  '/meatspace',
  '/media',
  '/messages',
  '/local-llm/',
  '/pipeline/issues/',
  '/pipeline/series/',
  '/post',
  // Models mirrors Settings: PageHeader + TabPills over a `flex-1 overflow-auto`
  // body, so the page owns its own scroll. Without this it nests inside the
  // padded scrolling main and the inner `h-full` clips below the fold.
  '/models',
  '/api-reference',
  '/settings',
  // Round editor (/rounds/:id) and the Learning Guide (/rounds/guide).
  // The /rounds index is an EXACT full-width entry above.
  '/rounds/',
  '/wiki',
  // Universe editor (/universes/:id, /universes/new). The /universes
  // index is an EXACT full-width entry above.
  '/universes/',
  // Story Builder detail (/story-builder/:id/:step). The index is an
  // EXACT full-width entry above.
  '/story-builder/',
  // FableLoom editor (/fableloom/:loomId/...). The index is an EXACT
  // full-width entry above.
  '/fableloom/',
  // The AI Providers editor is a drawer over the same page (/ai/new,
  // /ai/:providerId), so its sub-routes need the bare full-width main the
  // bare /ai index gets from EXACT_FULL_WIDTH_PATHS above — without it the
  // page's own `flex-1 overflow-auto` body sits inside a padded, scrolling
  // main and double-pads.
  '/ai/',
  '/writers-room',
  '/agents',
  '/shell/',
  '/timeline/',
  // Every SongBook route — index (/songbook), import (/songbook/import),
  // and viewer (/songbook/:id) — is full-bleed and owns its own scroll
  // (flex-col h-full + an internal overflow-auto region; the viewer adds
  // its autoscroll container). They share the standard bordered
  // PageHeader bar over that scroll region.
  '/songbook',
  // Same component on the index and the :id route, so both own the
  // PageHeader shell (#10994).
  '/sprites',
  '/authors',
  '/sharing',
  '/voices',
];

const FULL_WIDTH_PATH_REGEXES = [
  // Music mirrors the Media Gen page shell: title bar + tabs over a separately
  // scrolling body. Keep this boundary-specific so `/music-video` retains its
  // own route classification.
  /^\/music(?:\/|$)/,
  // Music Video is a full-width PageHeader over its own scroll body (which
  // holds the sticky project header and stage tabs) — in the padded main its
  // bordered title bar sat indented inside the page padding.
  /^\/music-video(?:\/|$)/,
  // Video workspace (`/video`) owns its own header+scroll shell. Generate
  // Video (`/video/generate`) uses the MediaGen tab shell (header + tabs +
  // overflow-auto body), so it must stay full-width with that shell — taking
  // it off full-width double-pads; leaving it full-width without the shell
  // clips the form. Boundary-specific so `/video-gen` (legacy redirect) is
  // not swallowed the way a `/video` prefix would.
  /^\/video(?:\/|$)/,
  // Game detail (/game/:id) owns an internal scroll region. The bare
  // /game index is an EXACT full-width entry above; this stays
  // one-segment so /game/:id/:extra is not swallowed.
  /^\/game\/[^/]+\/?$/,
  // Only the App DETAIL editor (/apps/:id, /apps/:id/:tab) is
  // full-width and owns its own scroll; the Add App form
  // (/apps/create) is a plain scrolling page and must stay OUT of
  // full-width, or its content clips below the fold (it has no
  // internal overflow-y-auto container). The trailing (?:\/|$) +
  // create(?:\/|$) lookahead also excludes the trailing-slash URL
  // /apps/create/ (React Router treats it as the same route).
  /^\/apps\/(?!create(?:\/|$))[^/]+(?:\/|$)/,
];

// Exported for the table-driven regression test in Layout.test.jsx — the
// classification rules above have no other coverage, and a dropped or retyped
// entry silently changes a page's layout.
export function isFullWidthRoute(pathname) {
  return EXACT_FULL_WIDTH_PATHS.includes(pathname) ||
    FULL_WIDTH_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    FULL_WIDTH_PATH_REGEXES.some((re) => re.test(pathname));
}
