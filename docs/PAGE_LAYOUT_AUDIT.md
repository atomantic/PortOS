# Routed page layout audit — 2026-10-23

Base: `040c183c31b5b7398e4b700e67c14363a1577566` (fetched `origin/main`).
Scope: page-level outer margins/padding and section navigation, using Code Animation as the reference. “Zero margin/padding” means no **outer gutter around the title and nav bars**; their intrinsic text/button padding is necessary for readable labels and touch targets. Content gutters, bounded reading columns, cards, editor panes and viewport surfaces remain intentional.

`PageLayout` shares the flush chrome / bounded scroll-body contract without a global CSS reset. `layoutRoutes.js` only adds full-width classification where the route now owns its scroll. Existing responsive tab icons, keyboard handling, deep links, feature gates and panel ARIA references are preserved. CoS's avatar titles become h2 beneath the single page h1.

## Chief of Staff matrix

All tabs are rendered by the same `ChiefOfStaff` shell. Tab bodies were inspected; no per-tab padding reset is applied. Agent deep links (`/cos/:tab/:agentId`) use that same shell.

| Route | Result / preserved behavior |
| --- | --- |
| `/cos/briefing` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/tasks` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/agents` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/jobs` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/runs` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/run-events` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/schedule` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/workflow` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/digest` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/gsd` | Flush shared title/nav; existing tab content spacing and lazy loading retained. Feature visibility gate retained. |
| `/cos/learning` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/memory` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/mind` | Mind chat retains its `min-h-0` / desktop flex sizing and internal pane scroll. |
| `/cos/health` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos/config` | Flush shared title/nav; existing tab content spacing and lazy loading retained. |
| `/cos`, `/cos/tools`, `/cos/mind/tools` | Existing redirects retained, including the Mind tools query parameter. |

## Routed page inventory

Grouped by rendered component, including param/deep-link routes. “Retained” is a source audit disposition, not a claim that every page was browser-tested. Child routes hosted by MediaGen inherit its full-width chrome. Redirect-only routes are listed separately.

| Route(s) | Disposition | Reason |
| --- | --- | --- |
| `/ai/presets`, `/ai/presets/new`, `/ai/presets/:presetId`, `/ai/edit/:providerId`, `/ai/fleet`, `/ai/harnesses`, `/ai/harnesses/:harnessId`, `/ai/services`, `/ai/services/new`, `/ai/services/:serviceSlug` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/agents`, `/agents/:agentId`, `/agents/:agentId/:tab` | Fixed | Detail navigation now uses flush TabPills with compact mobile icons; list and record identity bars stay full width. |
| `/devtools/agents` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/ambient` | Intentional layout | Standalone ambient display; intentionally outside the application chrome. |
| `/api-reference/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/apps/:appId`, `/apps/:appId/:tab` | Intentional layout | App record editor; existing full-width title/nav and internal scroll. |
| `/apps` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/ask`, `/ask/:conversationId` | Intentional layout | Conversation workspace; dedicated chat toolbar and message scrolling. |
| `/authors`, `/authors/:authorId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/brain/:tab/:recordType/:recordId`, `/brain/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/brain/links/:id/scan-report` | Intentional layout | Bounded scan-report document and verdict controls, with its own scroll. |
| `/browser` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/calendar/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/capabilities` | Fixed | Added shared h1/scroll shell; readiness cards and disclosures retained. |
| `/catalog` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/catalog/ingest` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/catalog/:type/:id`, `/casting/:id/:tab?`, `/environments/:id/:tab?`, `/objects/:id/:tab?` | Intentional layout | Catalog record editor with its own toolbar, tabs and pane scrolling. |
| `/character` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/cos/:tab/:agentId`, `/cos/:tab` | Fixed | PageLayout: title and compact route tabs precede the avatar/content split; existing rail, pane padding and Mind sizing retained. |
| `/code-animation`, `/code-animation/gallery`, `/code-animation/:jobId`, `/code-animation/production`, `/code-animation/production/:projectId` | Reference preserved | Canonical reference adopted PageLayout with the same title, tabs, gutters and max-w-7xl body. |
| `/apps/create` | Intentional layout | Bounded app-import form with sticky supporting aside; default main scroll is intentional. |
| `/casting/import` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/creative-commission/:id` | Intentional layout | Commission record/status workspace; bounded record content. |
| `/creative-commission`, `/creative-commission/new` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/video`, `/creative-director` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/creative-director/:id/:tab/:sceneId`, `/creative-director/:id/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/casting`, `/environments`, `/objects` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/` | Intentional layout | Widget canvas with its own arrangement and dashboard spacing; no section tab strip. |
| `/devtools/datadog` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/data` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/decks/:id` | Intentional layout | Deck editing/preview workspace; dedicated record toolbar. |
| `/decks` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/digital-twin/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/eidoverse/solo`, `/eidoverse` | Intentional layout | Immersive world and solo surface; dedicated viewport/HUD layout. |
| `/eidoverse/guest` | Intentional layout | Guest admission/world surface, outside the operator shell. |
| `/fableloom` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/fableloom/join` | Intentional layout | Hosted join flow, outside the operator shell. |
| `/fableloom/:loomId`, `/fableloom/:loomId/:episodeId/outline`, `/fableloom/:loomId/:episodeId`, `/fableloom/:loomId/:episodeId/:nodeId` | Intentional layout | Story/episode editor; data-driven episode picker intentionally retained. |
| `/feature-agents/create`, `/feature-agents/:id/:tab` | Fixed | Moved record tabs out of the padded header into TabPills; kept record identity/back navigation. |
| `/feature-agents` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/flows` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/game`, `/game/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/github`, `/devtools/github/:tab`, `/devtools/github/:tab/:accountId/:threadId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/goals/:tab`, `/goals/list/:goalId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/history` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/imessage/:chatKey` | Intentional layout | Legacy chat deep link; dedicated conversation panes. |
| `/devtools/image-clean` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/media/image` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/importer` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/insights/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/instances` | Fixed | Added shared title/scroll shell around the existing federation provider and drawers. |
| `/devtools/jira` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/jira/reports` | Intentional layout | Bounded report reader/master-detail view with report filters; not a section header/nav shell. |
| `/local-llm/playground` | Intentional layout | Full-width model playground; independent conversation panes. |
| `/login` | Intentional layout | Authentication surface, outside the operator shell. |
| `/loops` | Fixed | Added shared title/scroll shell; retained creation controls, counters, and responsive cards. |
| `/meatspace/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/3d` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/3d/:id` | Intentional layout | 3D record/preview surface; dedicated record controls. |
| `/media/annotate`, `/media/annotate/:mediaKey` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media/collections/:id` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media/collections/:id/sync` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media/collections` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media`, `/video/generate` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/media/history` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/messages/:tab/:chatKey`, `/messages/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/models/llms-runtimes/:recordId?`, `/models/performance/results/:assessmentKey`, `/models/performance/:view`, `/models/:tab`, `/models/:tab/:recordId`, `/models/decision-classifiers/jev/:taskView`, `/models/llms/jev/:taskView` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/mood-boards/:id` | Intentional layout | Board editor toolbar and canvas; record controls remain local to the editor. |
| `/mood-boards` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/music`, `/music/:tab`, `/music/:tab/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/music-video`, `/music-video/:projectId`, `/music-video/:projectId/:stage`, `/music-video/:projectId/:stage/scene/:sceneId`, `/music-video/:projectId/scene/:sceneId`, `/music-video/:projectId/dev/:artifactId`, `/music-video/:projectId/:stage/dev/:artifactId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/*` | Intentional layout | Small missing-route message in the default document scroller. |
| `/openclaw` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/pipeline` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/pipeline/series/:seriesId/continuity-bible` | Intentional layout | Series reference document/workbench; own record toolbar and scroll. |
| `/pipeline/editorial-checks` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/pipeline/series/:seriesId/export` | Intentional layout | Series export workbench; record-specific actions. |
| `/pipeline/issues/:issueId/:stage` | Intentional layout | Stage editor with record/stage navigation and independent scroll. |
| `/pipeline/series/:seriesId/manuscript/*` | Intentional layout | Manuscript editor with independent text/outline scrolling. |
| `/pipeline/series/:seriesId/reverse-outline` | Intentional layout | Series outline document/workbench; own record toolbar and scroll. |
| `/pipeline/series/:seriesId` | Intentional layout | Series workspace with record header and nested panels. |
| `/pipeline/series/:seriesId/roadmap` | Intentional layout | Series planning canvas with record-specific navigation. |
| `/pipeline/series/:seriesId/voice-fingerprint` | Intentional layout | Series diagnostic document/workbench; own record toolbar and scroll. |
| `/post/:tab`, `/post/:tab/:subtab`, `/post/:tab/:subtab/:mode` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/privacy/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/processes` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/media/prompt`, `/media/prompt/:examinationId` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/prompts` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/quota-burn`, `/devtools/quota-burn/:familyId` | Fixed | Added flush PageHeader and existing Models navigation; retained autosave/actions and card spacing. |
| `/rapid-reader`, `/rapid-reader/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/review`, `/review/:actionId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/rounds/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/rounds` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/rounds/guide` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/runner` | Fixed | Moved PageHeader out of the padded document flow; PageLayout owns the padded scroll body. |
| `/security` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/settings/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/sharing`, `/sharing/:section`, `/sharing/:section/:bucketId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/shell`, `/shell/iterm`, `/shell/iterm/:itermSessionId`, `/shell/:sessionId` | Intentional layout | Terminal workspace with session controls and terminal scroll owner. |
| `/songbook` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/songbook/import` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/songbook/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/sprites`, `/sprites/:id` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/stacker-news`, `/stacker-news/:accountId/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/start-story` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/story-builder`, `/story-builder/:storyId/:step` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/storyboards/:id`, `/storyboards/:id/panel/:panelId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/storyboards` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/universes/:universeId/sync`, `/pipeline/series/:seriesId/sync` | Intentional layout | Record-specific sync review/compare surface. |
| `/system-resources/:tab` | Fixed | Replaced inset rounded hero/nav with flush title/nav; retained max-w-7xl report body. |
| `/templates` | Fixed | Added shared title/scroll shell; template cards and create form retain their spacing. |
| `/media/threejs/:id` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media/threejs` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/timeline`, `/timeline/:date` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/tribe` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/universes/new`, `/universes/:universeId` | Intentional layout | Universe editor with record header and independent panes. |
| `/universes` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/uploads` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/devtools/usage` | Fixed | Added flush title/nav, one padded content scroller, and wrapping date-range controls; card padding remains local. |
| `/devtools/video-download` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/media/timeline` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/media/timeline/:projectId` | Retained, nested | Hosted by MediaGen; local gallery/form/editor controls are content, not duplicate page chrome. |
| `/voice/call-host` | Intentional layout | Dedicated call-host status/permission surface; no section navigation. |
| `/voices`, `/voices/:profileId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/wiki/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/workspace-contexts`, `/workspace-contexts/:appId` | Fixed | Moved title outside the max-w-5xl content column; retained bounded prose/forms. |
| `/writers-room`, `/writers-room/works/:workId` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/writers-room/guide` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |
| `/x`, `/x/:accountId/:tab` | Retained, flush | Existing full-width title/navigation shell and internal content scrolling; no outer-gutter mismatch found. |

## Redirect-only routes

Existing bookmark/legacy redirects are unchanged; destination layouts are covered above.

`/devtools`, `/devtools/runs`, `/devtools/submodules`, `/ai`, `/ai/new`, `/ai/connections`, `/ai/connections/:connectionId`, `/ai/harnesses/:harnessId/connections`, `/ai/harnesses/:harnessId/connections/:connectionId`, `/cos`, `/cos/mind/tools`, `/cos/tools`, `/calendar`, `/brain`, `/digital-twin`, `/privacy`, `/goals`, `/feature-agents/:id`, `/settings`, `/settings/catalog`, `/settings/contacts`, `/settings/local-llm`, `/settings/embeddings`, `/settings/code-reviewers`, `/settings/spotify`, `/settings/youtube`, `/api-reference`, `/models`, `/models/llms/jev`, `/models/llms/runtimes`, `/models/harnesses`, `/insights`, `/system-health`, `/system-resources`, `/system-resources/models`, `/meatspace`, `/post`, `/messages`, `/imessage`, `/annotate`, `/annotate/:mediaKey`, `/datadog`, `/jira`, `/openworld`, `/openworld/*`, `/city`, `/city/*`, `/media/video`, `/media/creative-director`, `/media/creative-director/:id`, `/media/creative-director/:id/:tab/:sceneId`, `/media/creative-director/:id/:tab`, `/media/music-video`, `/media/music-video/:projectId`, `/media/sprites`, `/media/sprites/:id`, `/media/models`, `/media/3d`, `/media/3d/:id`, `/media/loras`, `/media/training`, `/media/training/:datasetId`, `/media/universe-builder`, `/media/universe-builder/:universeId`, `/media/universe-builder/:universeId/canon`, `/video/:id`, `/video/:id/:tab/:sceneId`, `/video/:id/:tab`, `/creative-director/:id`, `/image-gen`, `/video-gen`, `/media-history`, `/media-models`, `/wiki`, `/universes/:universeId/canon`, `/universe-builder`, `/universe-builder/:universeId/canon`, `/universe-builder/:universeId`, `/universe-builder/new`, `/story-builder/:storyId`, `/pipeline/findings/:commentId`, `/pipeline/issues/:issueId`.

## Usage card diagnosis

`/devtools/usage` previously combined Layout's padded scrolling main with a full-height Models wrapper and another unpadded scroller. The page now owns one scroll body with symmetric 16px narrow / 24px desktop gutters. Provider cards already had symmetric local `p-2 sm:p-4`; those values are preserved. Real Chromium also reproduced a separate **320px overflow inside the date-filter card**: its From/To inputs were one non-wrapping flex item. Each label/input pair now stays together while the group can wrap. No overflow-hiding or global card padding rule is used.

## Validation

See final task handoff for command outcomes. `PageLayout.browser.test.js` renders real route components and Tailwind against synthetic API fixtures, with the available content width reduced by a 256px desktop global rail. It checks Code Animation, CoS Agents/Health, System Resources Storage, and Usage at 1440, 1024, 390 and 320px. Assertions cover flush title/nav rectangles, a single h1, scroll containment, both card gutters, balanced card padding, and card overflow. Usage includes provider quota cards and a cost report with a long model name. Screenshots are optional via `PORTOS_LAYOUT_SCREENSHOTS`; no private instance data is used. This fixture does not boot the production backend or assert every audited route visually.
