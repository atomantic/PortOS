// Routes whose main content owns its own internal scroll region and needs the
// bare full-width `<main>` (relative overflow-hidden) instead of the default
// padded+scrolling one. Checked in order: exact path, then prefix, then
// regex — see `isFullWidthRoute` below.
const EXACT_FULL_WIDTH_PATHS = [
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
];

const FULL_WIDTH_PATH_PREFIXES = [
  '/ask/',
  '/calendar',
  // Only the Catalog DETAIL editor (/catalog/{type}/{id}) and the
  // Ingest page (/catalog/ingest) are full-width — they own their
  // own scroll. The /catalog list/index page stays scrolling-default.
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
  // Round EDITOR (/rounds/:id) and the Learning Guide (/rounds/guide)
  // are full-width and own their own scroll; the bare /rounds index
  // (list + create form) takes the normal padded+scrolling main.
  '/rounds/',
  '/wiki',
  // Only the universe EDITOR (/universes/:id, /universes/new) is
  // full-width — it manages its own scroll. The /universes index
  // (list/table) takes the normal padded+scrolling main, mirroring
  // the Series Pipeline index (/pipeline is not full-width either).
  '/universes/',
  // Story Builder DETAIL (/story-builder/:id/:step) is a full-width
  // stepper that owns its own scroll; the bare /story-builder index
  // (list + create form) takes the normal padded+scrolling main.
  '/story-builder/',
  // FableLoom EDITOR (/fableloom/:loomId/...) is a full-width canvas that
  // owns its own scroll; the bare /fableloom index takes the normal
  // padded+scrolling main.
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
];

const FULL_WIDTH_PATH_REGEXES = [
  // Music mirrors the Media Gen page shell: title bar + tabs over a separately
  // scrolling body. Keep this boundary-specific so `/music-video` retains its
  // own route classification.
  /^\/music(?:\/|$)/,
  // Video workspace (`/video`) owns its own header+scroll shell. Generate
  // Video (`/video/generate`) uses the MediaGen tab shell (header + tabs +
  // overflow-auto body), so it must stay full-width with that shell — taking
  // it off full-width double-pads; leaving it full-width without the shell
  // clips the form. Boundary-specific so `/video-gen` (legacy redirect) is
  // not swallowed the way a `/video` prefix would.
  /^\/video(?:\/|$)/,
  // Only Game DETAIL workspaces own an internal scroll region; the
  // bare /game index stays on the normal padded page layout.
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

// Exported for the table-driven regression test in Layout.test.jsx — the 41
// classification rules above have no other coverage, and a dropped or retyped
// entry silently changes a page's layout.
export function isFullWidthRoute(pathname) {
  return EXACT_FULL_WIDTH_PATHS.includes(pathname) ||
    FULL_WIDTH_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    FULL_WIDTH_PATH_REGEXES.some((re) => re.test(pathname));
}
