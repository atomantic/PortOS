// Single source of truth for nav (`⌘K` palette + voice).
//
// Add an entry when you add a page. Also `getNavPageForPath(pathname)` → `{ label, section, breadcrumb
// }` for the most specific command that owns a route (`null` for one nothing declares) — how
// user-facing copy NAMES a page it links to, instead of typing "Models → LLMs" beside the link and
// stranding it on the next move (#7414). `expandPageToken(text, runtime)` expands a `{page}` token in
// `text` using `getNavPageForPath(runtime?.manageUrl)`, falling back to generic prose rather than
// shipping a literal `{page}` (#7419).
//
// Single source of truth for PortOS navigation. Consumed by the sidebar,
// App.jsx redirects, and (via navSearchMetadata.js) voice/Cmd+K search.
// Entry: { id, path, label, section, tabId?, tabGroup?, navGroup?, parentPath?, tabLabel?, previousPaths?, preservePreviousPathSuffix? }.
// Search aliases and keywords live in `server/lib/navSearchMetadata.js` keyed by `id`.
// See AGENTS.md "Command Palette & Voice Nav" for the contract.
//
// `previousPaths` lists every path this page has ANSWERED TO BEFORE — including
// its parameterized drill-downs as React Router patterns (a deep link into a
// detail view is exactly the kind of bookmark that breaks silently; a trailing
// `/*` covers a whole retired subtree). Bookmarks, stale palette history, and
// links held by other installs all still say the old path, so a move that drops the redirect 404s them — and nothing else notices,
// because every other guard here only looks at where a route points now. Declaring
// the old path IS the redirect: App.jsx generates one redirect route per entry
// (carrying the trailing segments, query and hash unless
// `preservePreviousPathSuffix: false`), and the sidebar migrates stored pins with
// the same pattern match (client/src/lib/previousPaths.js).

import { PORTOS_APP_ID } from './appIdentity.js';

// Sections whose every page belongs to one optional instance feature, so a page
// added there inherits the gate with no edit. A single page inside an otherwise
// ungated section (DataDog, JIRA) carries `feature` on its own entry instead.
// Keys must be real section labels and values must be ids declared in
// server/lib/instanceFeatureRegistry.js — navManifest.test.js fails on both
// kinds of drift, because a stale key here would silently un-gate a section
// with every other assertion still green.
export const SECTION_FEATURE = new Map([
  ['Health', 'health'],
  ['POST', 'post'],
]);

export const PROVIDERS_PAGE_PATH = '/ai/presets';

const RAW_NAV_COMMANDS = [
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main' },
  { id: 'nav.review-hub', path: '/review', label: 'Review Hub', section: 'Main' },
  { id: 'nav.eidoverse.guest', path: '/eidoverse/guest', label: 'Eidoverse Guest', section: 'Main', feature: 'eidoverse' },
  { id: 'nav.eidoverse.solo', path: '/eidoverse/solo', label: 'Eidoverse World Only', section: 'Main', feature: 'eidoverse' },
  { id: 'nav.eidoverse', path: '/eidoverse', label: 'Eidoverse', section: 'Main', feature: 'eidoverse', previousPaths: ['/openworld', '/openworld/*', '/city', '/city/*'], preservePreviousPathSuffix: false },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'Main' },
  // Submodules are per-app (a tab on the app detail page), so this entry is
  // explicitly PortOS's own — the only repo whose app id is a fixed constant.
  // Every other app reaches its tab from /apps/<id>/submodules.
  { id: 'nav.apps.submodules', path: `/apps/${PORTOS_APP_ID}/submodules`, label: 'PortOS Submodules', section: 'Apps', previousPaths: ['/devtools/submodules'] },
  { id: 'nav.templates', path: '/templates', label: 'Templates', section: 'Main' },

  { id: 'nav.create.media-studio', path: '/create/media', label: 'Media Studio', section: 'Create' },
  { id: 'nav.create.story-studio', path: '/create/story', label: 'Story Studio', section: 'Create' },
  { id: 'nav.catalog', path: '/catalog', label: 'Catalog', section: 'Create' },
  { id: 'nav.catalog.ingest', path: '/catalog/ingest', label: 'Catalog Ingest', section: 'Create' },
  { id: 'nav.catalog.settings', path: '/catalog?settings=1', label: 'Catalog Types', section: 'Create', previousPaths: ['/settings/catalog'] },
  { id: 'nav.create.casting', path: '/catalog/casting', label: 'Casting', section: 'Create', parentPath: '/catalog', previousPaths: ['/casting'] },
  // ⌘K / voice only — no sidebar row: reached from the Casting, Environments and Objects headers.
  { id: 'nav.create.casting-import', path: '/casting/import', label: 'Import Cast from Music Videos', section: 'Create' },
  { id: 'nav.create.environments', path: '/catalog/environments', label: 'Environments', section: 'Create', parentPath: '/catalog', previousPaths: ['/environments'] },
  { id: 'nav.create.objects', path: '/catalog/objects', label: 'Objects', section: 'Create', parentPath: '/catalog', previousPaths: ['/objects'] },
  { id: 'nav.media', path: '/media', label: 'Media Gen', section: 'Create', parentPath: '/create/media' },
  { id: 'nav.media.image', path: '/media/image', label: 'Image', section: 'Create', tabGroup: 'media', tabId: 'image', previousPaths: ['/image-gen'] },
  { id: 'nav.media.video', path: '/video/generate', label: 'Generate Video', tabLabel: 'Video', section: 'Create', tabGroup: 'media', tabId: 'video', previousPaths: ['/video-gen', '/media/video'] },
  { id: 'nav.media.prompt', path: '/media/prompt', label: 'Prompt from Media', tabLabel: 'Prompt', section: 'Create', tabGroup: 'media', tabId: 'prompt' },
  { id: 'nav.media.threejs', path: '/media/threejs', label: 'Three.js Models', section: 'Create', tabGroup: 'media', tabId: 'threejs', tabLabel: 'Three.js' },
  { id: 'nav.media.pages', path: '/html-pages', label: 'HTML Pages', section: 'Create', previousPaths: ['/media/pages'] },
  { id: 'nav.media.pages.runs', path: '/html-pages/runs', label: 'HTML Pages Runs', section: 'Create' },
  { id: 'nav.media.pages.gallery', path: '/html-pages/gallery', label: 'HTML Pages Gallery', section: 'Create' },
  { id: 'nav.media.annotate', path: '/media/annotate', label: 'Annotate', section: 'Create', tabGroup: 'media', tabId: 'annotate', previousPaths: ['/annotate', '/annotate/:mediaKey'] },
  { id: 'nav.media.timeline', path: '/media/timeline', label: 'Timeline', section: 'Create', tabGroup: 'media', tabId: 'timeline' },
  { id: 'nav.media.history', path: '/media/history', label: 'Media History', section: 'Create', tabGroup: 'media', tabId: 'history', tabLabel: 'History', previousPaths: ['/media-history'] },
  { id: 'nav.media.collections', path: '/media/collections', label: 'Collections', section: 'Create', tabGroup: 'media', tabId: 'collections' },
  { id: 'nav.create.code-animation', path: '/code-animation', label: 'Code Animation', section: 'Create', parentPath: '/create/media' },
  { id: 'nav.create.code-animation.gallery', path: '/code-animation/gallery', label: 'Code Animation Gallery', section: 'Create' },
  { id: 'nav.create.code-animation.production', path: '/code-animation/production', label: 'Code Animation Production', section: 'Create' },
  { id: 'nav.create.creative-director', path: '/creative-director', label: 'Creative Director', section: 'Create', parentPath: '/create/media', previousPaths: ['/video', '/video/:id', '/video/:id/:tab', '/video/:id/:tab/:sceneId', '/media/creative-director', '/media/creative-director/:id', '/media/creative-director/:id/:tab', '/media/creative-director/:id/:tab/:sceneId'] },
  { id: 'nav.create.creative-commission', path: '/creative-commission', label: 'Creative Commissions', section: 'Create', parentPath: '/create/media' },
  { id: 'nav.create.fableloom', path: '/fableloom', label: 'FableLoom', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.game', path: '/game', label: 'Game', section: 'Create' },
  { id: 'nav.create.music-video', path: '/music-video', label: 'Music Video', section: 'Create', parentPath: '/create/media', previousPaths: ['/media/music-video', '/media/music-video/:projectId', '/media/music-video/*'] },
  { id: 'nav.create.music-video.new', path: '/music-video?new=project', label: 'New Music Video', section: 'Create' },
  { id: 'nav.create.music-video.setup', path: '/music-video/setup', label: 'Music Video Song', section: 'Create' },
  { id: 'nav.create.music-video.cast-sets', path: '/music-video/cast-sets', label: 'Music Video Look', section: 'Create' },
  { id: 'nav.create.music-video.board', path: '/music-video/board', label: 'Music Video Storyboard', section: 'Create' },
  { id: 'nav.create.music-video.previz', path: '/music-video/previz', label: 'Music Video Previz', section: 'Create' },
  { id: 'nav.create.music-video.produce', path: '/music-video/produce', label: 'Music Video Shots', section: 'Create' },
  { id: 'nav.create.music-video.review', path: '/music-video/review', label: 'Music Video Final Render', section: 'Create' },
  { id: 'nav.create.music-video.publish', path: '/music-video/publish', label: 'Music Video Publish', section: 'Create' },
  { id: 'nav.create.music-video.editor', path: '/music-video/editor', label: 'Music Video Editor', section: 'Create' },
  { id: 'nav.create.music-video.assets', path: '/music-video/assets', label: 'Music Video Assets', section: 'Create' },
  { id: 'nav.create.music-video-cleanup', path: '/music-video/cleanup', label: 'Music Video Cleanup', section: 'Create' },
  { id: 'nav.create.decks', path: '/decks', label: 'Decks', section: 'Create' },
  { id: 'nav.create.mood-boards', path: '/mood-boards', label: 'Mood Boards', section: 'Create' },
  { id: 'nav.create.storyboards', path: '/storyboards', label: 'Storyboards', section: 'Create', parentPath: '/create/media' },
  // Promoted out of the Media Gen tabs to a top-level Create page (#2930).
  // The id stays `nav.media.sprites` — it's opaque and stored in palette
  // history, so renaming it would orphan those entries.
  { id: 'nav.media.sprites', path: '/sprites', label: 'Sprites', section: 'Create', previousPaths: ['/media/sprites', '/media/sprites/:id'] },
  { id: 'nav.create.3d', path: '/3d', label: '3D', section: 'Create', previousPaths: ['/media/3d', '/media/3d/:id'] },
  { id: 'nav.create.authors', path: '/authors', label: 'Authors', section: 'Create' },
  { id: 'nav.create.voice-studio', path: '/voices', label: 'Voice Studio', section: 'Create' },
  { id: 'nav.create.universe-builder', path: '/universes', label: 'Universes', section: 'Create', previousPaths: ['/media/universe-builder', '/media/universe-builder/:universeId', '/universe-builder', '/universe-builder/:universeId'] },
  { id: 'nav.create.importer', path: '/importer', label: 'Importer', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.pipeline', path: '/pipeline', label: 'Series Pipeline', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.pipeline.editorial-checks', path: '/pipeline/editorial-checks', label: 'Editorial Checks', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.pipeline-continuity-bible', path: '/pipeline', label: 'Series Continuity', section: 'Create' },
  { id: 'nav.create.pipeline-voice-fingerprint', path: '/pipeline', label: 'Voice Fingerprint', section: 'Create' },
  { id: 'nav.create.pipeline-export', path: '/pipeline', label: 'Prose Series Export', section: 'Create' },
  { id: 'nav.create.sharing', path: '/sharing', label: 'Sharing', section: 'Create', tabGroup: 'sharing', tabId: 'buckets', tabLabel: 'Buckets' },
  { id: 'nav.create.sharing-duplicates', path: '/sharing/duplicates', label: 'Duplicates', section: 'Create', tabGroup: 'sharing', tabId: 'duplicates' },
  { id: 'nav.create.sharing-conflicts', path: '/sharing/conflicts', label: 'Conflicts', section: 'Create', tabGroup: 'sharing', tabId: 'conflicts' },
  { id: 'nav.create.start-story', path: '/start-story', label: 'Start a Story', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.story-builder', path: '/story-builder', label: 'Story Builder', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.create.rounds', path: '/rounds', label: 'Rounds', section: 'Create' },
  { id: 'nav.create.rounds-guide', path: '/rounds/guide', label: 'Rounds Guide', section: 'Create' },
  { id: 'nav.create.music', path: '/music', label: 'Music', section: 'Create' },
  { id: 'nav.create.music-generate', path: '/music/generate', label: 'Music Designer', section: 'Create', tabGroup: 'music', tabId: 'generate', tabLabel: 'Generate' },
  { id: 'nav.create.music-artists', path: '/music/artists', label: 'Music Artists', section: 'Create', tabGroup: 'music', tabId: 'artists', tabLabel: 'Artists' },
  { id: 'nav.create.music-albums', path: '/music/albums', label: 'Music Albums', section: 'Create', tabGroup: 'music', tabId: 'albums', tabLabel: 'Albums' },
  { id: 'nav.create.music-tracks', path: '/music/tracks', label: 'Music Tracks', section: 'Create', tabGroup: 'music', tabId: 'tracks', tabLabel: 'Tracks' },
  { id: 'nav.media.settings', path: '/media/image?settings=1', label: 'Media Gen Settings', section: 'Create' },
  { id: 'nav.writers-room', path: '/writers-room', label: 'Writers Room', section: 'Create', parentPath: '/create/story' },
  { id: 'nav.writers-room.guide', path: '/writers-room/guide', label: 'Writers Room Guide', section: 'Create' },
  // /prompts lands on its Stages tab; each editor is its own `/prompts/:tab`
  // route, and a pre-route `/prompts?tab=` link redirects onto it in the page.
  { id: 'nav.settings.prompts', path: '/prompts', label: 'Prompts', section: 'Settings', tabId: 'prompts', navGroup: 'Agents' },
  { id: 'nav.settings.prompts.variables', path: '/prompts/variables', label: 'Prompt Variables', section: 'Settings' },
  { id: 'nav.settings.prompts.agent-skills', path: '/prompts/agent-skills', label: 'Agent Skills', section: 'Settings' },
  { id: 'nav.settings.prompts.job-skills', path: '/prompts/job-skills', label: 'Job Skills', section: 'Settings' },
  // The AI Providers page is three views over the composed model (#7567, epic
  // #7561): Presets (the stored records, the page's index), Harnesses (the
  // programs and their enablement, plus credential-bootstrap apps) and Services
  // (instances of a service definition: plan, credential, catalog). Each is its
  // own URL so a card can be linked and reached from ⌘K and voice; the retired
  // Backend Connections drawer (#6369) redirects onto Services.
  { id: 'nav.settings.providers', path: PROVIDERS_PAGE_PATH, label: 'Providers', section: 'Models', tabId: 'providers', navGroup: 'Connect', previousPaths: ['/ai'] },
  { id: 'nav.ai.harnesses', path: '/ai/harnesses', label: 'Harnesses', section: 'Models', tabId: 'harnesses', navGroup: 'Connect', previousPaths: ['/models/harnesses'] },
  { id: 'nav.ai.services', path: '/ai/services', label: 'AI Services', section: 'Models', tabId: 'services', navGroup: 'Connect', previousPaths: ['/ai/connections', '/ai/connections/:connectionId'] },
  { id: 'nav.settings.fleet-llm', path: '/ai/fleet', label: 'Fleet LLM Setup', section: 'Settings' },

  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Inbox', section: 'Brain', tabGroup: 'brain', tabId: 'inbox' },
  { id: 'nav.brain.threads', path: '/brain/threads', label: 'Threads', section: 'Brain', tabGroup: 'brain', tabId: 'threads' },
  { id: 'nav.brain.ideas', path: '/brain/ideas', label: 'Ideas', section: 'Brain', tabGroup: 'brain', tabId: 'ideas' },
  { id: 'nav.brain.daily-log', path: '/brain/daily-log', label: 'Daily Log', section: 'Brain', tabGroup: 'brain', tabId: 'daily-log' },
  { id: 'nav.brain.links', path: '/brain/links', label: 'Links', section: 'Brain', tabGroup: 'brain', tabId: 'links' },
  { id: 'nav.brain.meditation', path: '/brain/meditation', label: 'Meditation', section: 'Brain', tabGroup: 'brain', tabId: 'meditation' },
  { id: 'nav.brain.memory', path: '/brain/memory', label: 'Memory', section: 'Brain', tabGroup: 'brain', tabId: 'memory' },
  { id: 'nav.brain.notes', path: '/brain/notes', label: 'Notes', section: 'Brain', tabGroup: 'brain', tabId: 'notes' },
  { id: 'nav.brain.graph', path: '/brain/graph', label: 'Graph', section: 'Brain', tabGroup: 'brain', tabId: 'graph' },
  { id: 'nav.brain.digest', path: '/brain/digest', label: 'Digest', section: 'Brain', tabGroup: 'brain', tabId: 'digest' },
  { id: 'nav.brain.feeds', path: '/brain/feeds', label: 'Feeds', section: 'Brain', tabGroup: 'brain', tabId: 'feeds' },
  { id: 'nav.brain.trust', path: '/brain/trust', label: 'Trust', section: 'Brain', tabGroup: 'brain', tabId: 'trust' },
  { id: 'nav.brain.import', path: '/brain/import', label: 'Import', section: 'Brain', tabGroup: 'brain', tabId: 'import' },
  // Spotify and YouTube moved out of Settings into Brain (alongside Timeline,
  // which these feed) — ids kept stable since they're opaque, persisted
  // palette-history values; only the path and section move.
  { id: 'nav.settings.spotify', path: '/brain/spotify', label: 'Spotify', section: 'Brain', tabGroup: 'brain', tabId: 'spotify', previousPaths: ['/settings/spotify'] },
  { id: 'nav.settings.youtube', path: '/brain/youtube', label: 'YouTube', section: 'Brain', tabGroup: 'brain', tabId: 'youtube', previousPaths: ['/settings/youtube'] },
  { id: 'nav.brain.config', path: '/brain/config', label: 'Config', section: 'Brain', tabGroup: 'brain', tabId: 'config' },
  { id: 'nav.brain.idealoom', path: '/brain/ideas?view=lists', label: 'IdeaLoom Lists', section: 'Brain' },
  { id: 'nav.rapid-reader', path: '/rapid-reader', label: 'Rapid Reader', section: 'Brain' },
  // No 'songs'/'song' aliases — those already resolve to nav.create.rounds (first-declared wins).
  { id: 'nav.brain.songbook', path: '/songbook', label: 'SongBook', section: 'Brain' },

  { id: 'nav.calendar.agenda', path: '/calendar/agenda', label: 'Agenda', section: 'Calendar', tabGroup: 'calendar', tabId: 'agenda' },
  { id: 'nav.calendar.day', path: '/calendar/day', label: 'Day', section: 'Calendar', tabGroup: 'calendar', tabId: 'day' },
  { id: 'nav.calendar.week', path: '/calendar/week', label: 'Week', section: 'Calendar', tabGroup: 'calendar', tabId: 'week' },
  { id: 'nav.calendar.month', path: '/calendar/month', label: 'Month', section: 'Calendar', tabGroup: 'calendar', tabId: 'month' },
  { id: 'nav.calendar.lifetime', path: '/calendar/lifetime', label: 'Lifetime', section: 'Calendar', tabGroup: 'calendar', tabId: 'lifetime' },
  { id: 'nav.calendar.review', path: '/calendar/review', label: 'Review', section: 'Calendar', tabGroup: 'calendar', tabId: 'review' },
  { id: 'nav.calendar.sync', path: '/calendar/sync', label: 'Sync', section: 'Calendar', tabGroup: 'calendar', tabId: 'sync' },
  { id: 'nav.calendar.config', path: '/calendar/config', label: 'Config', section: 'Calendar', tabGroup: 'calendar', tabId: 'config' },

  { id: 'nav.cos.briefing', path: '/cos/briefing', label: 'Briefing', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'briefing' },
  { id: 'nav.cos.tasks', path: '/cos/tasks', label: 'Tasks', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'tasks' },
  { id: 'nav.cos.agents', path: '/cos/agents', label: 'Agents', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'agents' },
  { id: 'nav.cos.jobs', path: '/cos/jobs', label: 'System Tasks', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'jobs' },
  { id: 'nav.cos.runs', path: '/cos/runs', label: 'Runs', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'runs', previousPaths: ['/devtools/runs'] },
  { id: 'nav.cos.run-events', path: '/cos/runs/events', label: 'Run Events', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'run-events', previousPaths: ['/cos/run-events'] },
  { id: 'nav.cos.schedule', path: '/cos/schedule', label: 'Schedule', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'schedule' },
  // Keep the workflow aliases for the Schedule Timeline. Bare timeline belongs to Media Gen.
  { id: 'nav.cos.workflow', path: '/cos/schedule/timeline', label: 'Timeline', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'workflow', previousPaths: ['/cos/workflow'] },
  { id: 'nav.cos.digest', path: '/cos/briefing/digest', label: 'Digest', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'digest', previousPaths: ['/cos/digest'] },
  { id: 'nav.cos.gsd', path: '/cos/gsd', label: 'GSD', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'gsd', feature: 'gsd' },
  { id: 'nav.cos.learning', path: '/cos/learning', label: 'Learning', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'learning' },
  { id: 'nav.cos.memory', path: '/cos/memory', label: 'Memory', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'memory' },
  { id: 'nav.cos.mind', path: '/cos/mind', label: 'Mind', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'mind' },
  { id: 'nav.cos.health', path: '/cos/health', label: 'Health', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'health' },
  { id: 'nav.cos.config', path: '/cos/config', label: 'Config', section: 'Chief of Staff', tabGroup: 'cos', tabId: 'config' },
  { id: 'nav.feature-agents', path: '/feature-agents', label: 'Feature Agents', section: 'Chief of Staff' },
  { id: 'nav.cos.mind-tools', path: '/cos/mind?panel=tools', label: 'Mind Tools', section: 'Chief of Staff', previousPaths: ['/cos/tools', '/cos/mind/tools'] },
  { id: 'nav.social-agents', path: '/agents', label: 'Social Agents', section: 'Chief of Staff' },

  { id: 'nav.messages.inbox', path: '/messages/inbox', label: 'Inbox', section: 'Comms', tabGroup: 'messages', tabId: 'inbox' },
  { id: 'nav.messages.drafts', path: '/messages/drafts', label: 'Drafts', section: 'Comms', tabGroup: 'messages', tabId: 'drafts' },
  // Comms feature group (#40): iMessage and Signal join the existing FaceTime
  // Audio toggle under the `comms` group in instanceFeatureRegistry.js. The
  // `<Route>` itself keeps resolving with the feature off, so bookmarks, direct
  // links, and voice `ui_navigate` still land — only ⌘K/sidebar visibility gates.
  // `feature` rides through `getPageNavTabs` onto the Messages tab strip, so the
  // pill is gated by the same field the sidebar reads.
  { id: 'nav.messages.imessage', path: '/messages/imessage', label: 'iMessage', section: 'Comms', tabGroup: 'messages', tabId: 'imessage', feature: 'imessage', previousPaths: ['/imessage'] },
  { id: 'nav.messages.signal', path: '/messages/signal', label: 'Signal', section: 'Comms', tabGroup: 'messages', tabId: 'signal', feature: 'signal', previousPaths: ['/settings/signal'] },
  // Beeper (#30, fork issue #1): a local Beeper Desktop bridge fronting
  // WhatsApp/Discord/Telegram/Instagram/X/Slack and more, joining the Comms
  // group #40 stood up. Off by default (no detector — #11) — the route keeps
  // resolving with the feature off, so bookmarks and voice ui_navigate still land.
  { id: 'nav.messages.beeper', path: '/messages/beeper', label: 'Beeper', section: 'Comms', tabGroup: 'messages', tabId: 'beeper', feature: 'beeper' },
  // #35 turned /messages/beeper into the chat surface itself, so the ingestion
  // settings + status card moved into a drawer over it (?settings=1) — the same
  // shape iMessage uses. The entry exists so "open beeper settings" still lands
  // on the card rather than on the conversation list. Like iMessage Settings it
  // carries no `tabId`: the drawer is not its own pill in the tab strip. The open
  // CONVERSATION is /messages/beeper/:conversationId and deliberately has no
  // entry of its own: NAV_COMMANDS enumerates navigable PAGES, and a per-record
  // path would need a parameter the fuzzy resolver has no way to supply
  // (iMessage's :chatKey is absent for the same reason).
  { id: 'nav.messages.beeper-settings', path: '/messages/beeper?settings=1', label: 'Beeper Settings', section: 'Comms', feature: 'beeper' },
  { id: 'nav.messages.contacts', path: '/messages/contacts', label: 'Contacts', section: 'Comms', tabGroup: 'messages', tabId: 'contacts', previousPaths: ['/settings/contacts'] },
  // Ingestion config is a drawer over the iMessage manager (?settings=1), not a
  // Settings page — the settings-* aliases stay so "open iMessage settings" still lands.
  { id: 'nav.messages.imessage-settings', path: '/messages/imessage?settings=1', label: 'iMessage Settings', section: 'Comms', feature: 'imessage' },
  { id: 'nav.messages.sync', path: '/messages/sync', label: 'Sync', section: 'Comms', tabGroup: 'messages', tabId: 'sync' },
  { id: 'nav.messages.config', path: '/messages/config', label: 'Config', section: 'Comms', tabGroup: 'messages', tabId: 'config' },
  // X and Stacker News join the Comms feature group alongside iMessage,
  // Signal, and Beeper — default ON, so an existing install sees no change;
  // only ⌘K/sidebar visibility gates on the flag, the `<Route>` itself keeps
  // resolving with the feature off.
  { id: 'nav.stacker-news', path: '/stacker-news', label: 'Stacker News', section: 'Comms', feature: 'stacker-news' },
  { id: 'nav.x', path: '/x', label: 'X', section: 'Comms', feature: 'x' },
  { id: 'nav.timeline', path: '/timeline', label: 'Timeline', section: 'Brain' },
  { id: 'nav.tribe', path: '/tribe', label: 'Tribe', section: 'Brain' },

  { id: 'nav.devtools.agents', path: '/devtools/agents', label: 'AI Agents', section: 'Dev Tools' },
  { id: 'nav.browser', path: '/browser', label: 'Browser', section: 'Dev Tools' },
  { id: 'nav.devtools.runner', path: '/devtools/runner', label: 'Code', section: 'Dev Tools' },
  { id: 'nav.devtools.datadog', path: '/devtools/datadog', label: 'DataDog', section: 'Dev Tools', feature: 'datadog', previousPaths: ['/datadog'] },
  { id: 'nav.devtools.github', path: '/devtools/github', label: 'GitHub', section: 'Dev Tools' },
  // ⌘K / voice only — no sidebar row: tabs of the GitHub page.
  { id: 'nav.devtools.github-accounts', path: '/devtools/github/accounts', label: 'GitHub Accounts', section: 'Dev Tools' },
  { id: 'nav.devtools.github-inbox', path: '/devtools/github/inbox', label: 'GitHub Inbox', section: 'Dev Tools' },
  { id: 'nav.devtools.github-audit', path: '/devtools/github/audit', label: 'GitHub Notification Audit', section: 'Dev Tools' },
  { id: 'nav.devtools.github-automations', path: '/devtools/github/automations', label: 'GitHub Automations', section: 'Dev Tools' },
  { id: 'nav.devtools.github-repos', path: '/devtools/github/repos', label: 'GitHub Repos', section: 'Dev Tools' },
  { id: 'nav.devtools.history', path: '/devtools/history', label: 'History', section: 'Dev Tools' },
  { id: 'nav.devtools.image-clean', path: '/devtools/image-clean', label: 'Image Cleaner', section: 'Dev Tools' },
  { id: 'nav.devtools.jira', path: '/devtools/jira', label: 'JIRA', section: 'Dev Tools', feature: 'jira', previousPaths: ['/jira'] },
  { id: 'nav.devtools.jira-reports', path: '/devtools/jira/reports', label: 'JIRA Reports', section: 'Dev Tools', feature: 'jira' },
  { id: 'nav.devtools.quota-burn', path: '/devtools/quota-burn', label: 'Quota Burn', section: 'Models', tabId: 'quota-burn', navGroup: 'Operate' },
  { id: 'nav.shell', path: '/shell', label: 'Shell', section: 'Dev Tools' },
  // ⌘K / voice only — no sidebar row: the view is reached from the Shell page's
  // PortOS | iTerm2 switch (#8114).
  { id: 'nav.shell-iterm', path: '/shell/iterm', label: 'iTerm2 Sessions', section: 'Dev Tools', feature: 'iterm' },
  { id: 'nav.devtools.usage', path: '/devtools/usage', label: 'Usage', section: 'Models', tabId: 'usage', navGroup: 'Operate' },
  { id: 'nav.devtools.video-download', path: '/devtools/video-download', label: 'Video Downloader', section: 'Dev Tools' },
  { id: 'nav.workspace-contexts', path: '/workspace-contexts', label: 'Workspaces', section: 'Dev Tools' },

  // Digital Twin's 19 sections render as five groups in-page — Profile,
  // Sources, Assessment, Presence, Legacy (see
  // client/src/components/digital-twin/constants.js SECTION_GROUPS, #3795).
  // Each section keeps its own entry so ⌘K and voice still address it directly;
  // the grouping shows up here as a `keywords` group tag on every section plus a
  // `twin-<group>` alias on one member of each group, so "twin sources" lands
  // somewhere sensible without adding a group-only path that no route serves.
  // Declaration order below is the page's tab order, which runs group by group
  // (Profile → Sources → Assessment → Presence → Legacy) — getPageNavTabs
  // preserves it, and SECTION_GROUPS slices the same ids back into headers.
  { id: 'nav.twin.overview', path: '/digital-twin/overview', label: 'Overview', section: 'Identity', tabGroup: 'digital-twin', tabId: 'overview' },
  { id: 'nav.twin.identity', path: '/digital-twin/identity', label: 'Identity', section: 'Identity', tabGroup: 'digital-twin', tabId: 'identity' },
  { id: 'nav.twin.personas', path: '/digital-twin/personas', label: 'Personas', section: 'Identity', tabGroup: 'digital-twin', tabId: 'personas' },
  { id: 'nav.twin.goals', path: '/digital-twin/goals', label: 'Twin Goals', section: 'Identity', tabGroup: 'digital-twin', tabId: 'goals', tabLabel: 'Goals' },
  { id: 'nav.twin.taste', path: '/digital-twin/taste', label: 'Taste', section: 'Identity', tabGroup: 'digital-twin', tabId: 'taste' },
  { id: 'nav.twin.documents', path: '/digital-twin/documents', label: 'Documents', section: 'Identity', tabGroup: 'digital-twin', tabId: 'documents' },
  { id: 'nav.twin.import', path: '/digital-twin/import', label: 'Import', section: 'Identity', tabGroup: 'digital-twin', tabId: 'import' },
  { id: 'nav.twin.accounts', path: '/digital-twin/accounts', label: 'Accounts', section: 'Identity', tabGroup: 'digital-twin', tabId: 'accounts' },
  { id: 'nav.twin.interview', path: '/digital-twin/interview', label: 'Interview', section: 'Identity', tabGroup: 'digital-twin', tabId: 'interview' },
  { id: 'nav.twin.autobiography', path: '/digital-twin/autobiography', label: 'Autobiography', section: 'Identity', feature: 'autobiography', tabGroup: 'digital-twin', tabId: 'autobiography' },
  { id: 'nav.twin.enrich', path: '/digital-twin/enrich', label: 'Enrich', section: 'Identity', tabGroup: 'digital-twin', tabId: 'enrich' },
  { id: 'nav.twin.test', path: '/digital-twin/test', label: 'Test', section: 'Identity', tabGroup: 'digital-twin', tabId: 'test' },
  { id: 'nav.twin.personality', path: '/digital-twin/personality', label: 'Personality', section: 'Identity', tabGroup: 'digital-twin', tabId: 'personality' },
  { id: 'nav.twin.voice', path: '/digital-twin/voice', label: 'Voice', section: 'Identity', tabGroup: 'digital-twin', tabId: 'voice' },
  { id: 'nav.twin.appearance', path: '/digital-twin/appearance', label: 'Appearance', section: 'Identity', tabGroup: 'digital-twin', tabId: 'appearance' },
  { id: 'nav.twin.avatar-bio', path: '/digital-twin/avatar-bio', label: 'Avatar Bio', section: 'Identity', tabGroup: 'digital-twin', tabId: 'avatar-bio' },
  { id: 'nav.twin.export', path: '/digital-twin/export', label: 'Export', section: 'Identity', tabGroup: 'digital-twin', tabId: 'export' },
  { id: 'nav.twin.legacy', path: '/digital-twin/legacy', label: 'Legacy Bundle', section: 'Identity', tabGroup: 'digital-twin', tabId: 'legacy', tabLabel: 'Legacy' },
  { id: 'nav.twin.time-capsule', path: '/digital-twin/time-capsule', label: 'Time Capsule', section: 'Identity', tabGroup: 'digital-twin', tabId: 'time-capsule' },
  { id: 'nav.ask', path: '/ask', label: 'Ask Yourself', section: 'Identity' },
  { id: 'nav.character', path: '/character', label: 'Character', section: 'Identity' },
  { id: 'nav.goals', path: '/goals/list', label: 'Goals', section: 'Goals', tabGroup: 'goals', tabId: 'list', tabLabel: 'List' },
  { id: 'nav.goals.tree', path: '/goals/tree', label: 'Goals Tree', section: 'Goals', tabGroup: 'goals', tabId: 'tree', tabLabel: 'Tree' },
  { id: 'nav.insights', path: '/insights/overview', label: 'Insights', section: 'Identity', tabGroup: 'insights', tabId: 'overview', tabLabel: 'Overview' },
  { id: 'nav.insights.genome-health', path: '/insights/genome-health', label: 'Genome-Health', section: 'Identity', tabGroup: 'insights', tabId: 'genome-health' },
  { id: 'nav.insights.taste-identity', path: '/insights/taste-identity', label: 'Taste & Identity', section: 'Identity', tabGroup: 'insights', tabId: 'taste-identity' },
  { id: 'nav.insights.cross-domain', path: '/insights/cross-domain', label: 'Cross-Domain Patterns', section: 'Identity', tabGroup: 'insights', tabId: 'cross-domain' },
  { id: 'nav.insights.goal-scorecard', path: '/insights/goal-scorecard', label: 'Goal Scorecard', section: 'Identity', tabGroup: 'insights', tabId: 'goal-scorecard' },
  { id: 'nav.identity.privacy-overview', path: '/privacy/overview', label: 'Privacy', section: 'Identity', tabGroup: 'privacy', tabId: 'overview', tabLabel: 'Overview' },
  { id: 'nav.identity.privacy-vault', path: '/privacy/vault', label: 'Vault', section: 'Identity', tabGroup: 'privacy', tabId: 'vault' },
  { id: 'nav.identity.privacy-organizations', path: '/privacy/organizations', label: 'Organizations', section: 'Identity', tabGroup: 'privacy', tabId: 'organizations' },
  { id: 'nav.identity.privacy-changes', path: '/privacy/changes', label: 'Changes', section: 'Identity', tabGroup: 'privacy', tabId: 'changes' },
  { id: 'nav.identity.privacy-brokers', path: '/privacy/brokers', label: 'Brokers', section: 'Identity', tabGroup: 'privacy', tabId: 'brokers' },

  { id: 'nav.meatspace.overview', path: '/meatspace/overview', label: 'Overview', section: 'Health', tabGroup: 'meatspace', tabId: 'overview' },
  { id: 'nav.meatspace.age', path: '/meatspace/age', label: 'Age', section: 'Health', tabGroup: 'meatspace', tabId: 'age' },
  { id: 'nav.meatspace.alcohol', path: '/meatspace/alcohol', label: 'Alcohol', section: 'Health', tabGroup: 'meatspace', tabId: 'alcohol' },
  { id: 'nav.meatspace.blood', path: '/meatspace/blood', label: 'Blood', section: 'Health', tabGroup: 'meatspace', tabId: 'blood' },
  { id: 'nav.meatspace.body', path: '/meatspace/body', label: 'Body', section: 'Health', tabGroup: 'meatspace', tabId: 'body' },
  { id: 'nav.meatspace.export', path: '/meatspace/export', label: 'Export', section: 'Health', tabGroup: 'meatspace', tabId: 'export' },
  { id: 'nav.meatspace.genome', path: '/meatspace/genome', label: 'Genome', section: 'Health', tabGroup: 'meatspace', tabId: 'genome' },
  { id: 'nav.meatspace.health', path: '/meatspace/health', label: 'Body Health', section: 'Health', tabGroup: 'meatspace', tabId: 'health', tabLabel: 'Health' },
  { id: 'nav.meatspace.settings', path: '/meatspace/settings', label: 'Settings', section: 'Health', tabGroup: 'meatspace', tabId: 'settings' },
  { id: 'nav.meatspace.lifestyle', path: '/meatspace/lifestyle', label: 'Lifestyle', section: 'Health', tabGroup: 'meatspace', tabId: 'lifestyle' },
  { id: 'nav.meatspace.nicotine', path: '/meatspace/nicotine', label: 'Nicotine', section: 'Health', tabGroup: 'meatspace', tabId: 'nicotine' },

  { id: 'nav.post.launcher', path: '/post/launcher', label: 'Launcher', section: 'POST' },
  { id: 'nav.post.config', path: '/post/config', label: 'Config', section: 'POST' },
  { id: 'nav.post.explore', path: '/post/explore', label: 'Explore', section: 'POST' },
  { id: 'nav.post.history', path: '/post/history', label: 'History', section: 'POST' },
  { id: 'nav.post.memory', path: '/post/memory', label: 'Memory', section: 'POST' },
  { id: 'nav.post.memory.elements', path: '/post/memory/elements', label: 'Elements', section: 'POST' },
  // Elements practice modes are individually navigable, the way each Morse mode
  // is — so ⌘K and voice can start a drill instead of only opening the page
  // (issue #3249). Per-item memory routes (`/post/memory/:itemId`) stay dynamic
  // and unregistered, like other `:id` detail routes.
  { id: 'nav.post.memory.elements.study', path: '/post/memory/elements/element-study', label: 'Elements Flash Cards', section: 'POST' },
  { id: 'nav.post.memory.elements.flash', path: '/post/memory/elements/element-flash', label: 'Element Flash', section: 'POST' },
  { id: 'nav.post.memory.elements.lyrics', path: '/post/memory/elements/fill-blank', label: 'Elements Fill the Lyrics', section: 'POST' },
  { id: 'nav.post.memory.elements.learn', path: '/post/memory/elements/learn', label: 'Elements Learn Lyrics', section: 'POST' },
  { id: 'nav.post.morse', path: '/post/morse', label: 'Morse', section: 'POST' },
  { id: 'nav.post.plan', path: '/post/plan', label: 'Practice Plan', section: 'POST' },
  { id: 'nav.post.morse.copy', path: '/post/morse/copy', label: 'Morse Copy', section: 'POST' },
  { id: 'nav.post.morse.head-copy', path: '/post/morse/head-copy', label: 'Morse Head Copy', section: 'POST' },
  { id: 'nav.post.morse.send', path: '/post/morse/send', label: 'Morse Send', section: 'POST' },
  { id: 'nav.post.morse.tree', path: '/post/morse?ref=tree', label: 'Morse Tree', section: 'POST' },
  { id: 'nav.post.morse.length', path: '/post/morse?ref=length', label: 'Morse Length', section: 'POST' },
  { id: 'nav.post.morse.list', path: '/post/morse?ref=list', label: 'Morse List', section: 'POST' },
  { id: 'nav.post.progress', path: '/post/progress', label: 'Progress', section: 'POST' },
  { id: 'nav.post.progress.sessions', path: '/post/progress/sessions', label: 'Progress Sessions', section: 'POST' },
  { id: 'nav.post.rhetoric', path: '/post/rhetoric', label: 'Rhetoric', section: 'POST' },
  { id: 'nav.post.rhetoric.meter', path: '/post/rhetoric/meter', label: 'Rhetoric Iambic Pentameter', section: 'POST' },
  { id: 'nav.post.rhetoric.diacope', path: '/post/rhetoric/diacope', label: 'Rhetoric Diacope', section: 'POST' },
  { id: 'nav.post.rhetoric.chiasmus', path: '/post/rhetoric/chiasmus', label: 'Rhetoric Chiasmus', section: 'POST' },
  { id: 'nav.post.rhetoric.progressia', path: '/post/rhetoric/progressia', label: 'Rhetoric Progressia', section: 'POST' },
  { id: 'nav.post.rhetoric.brainstorm', path: '/post/rhetoric/brainstorm', label: 'Rhetorical Brainstorm', section: 'POST' },
  { id: 'nav.post.wordplay', path: '/post/wordplay', label: 'Wordplay', section: 'POST' },
  { id: 'nav.post.wordplay.compound-chain', path: '/post/wordplay/compound-chain', label: 'Compound Chain', section: 'POST' },
  { id: 'nav.post.wordplay.bridge-word', path: '/post/wordplay/bridge-word', label: 'Bridge Word', section: 'POST' },
  { id: 'nav.post.wordplay.double-meaning', path: '/post/wordplay/double-meaning', label: 'Double Meaning', section: 'POST' },
  { id: 'nav.post.wordplay.idiom-twist', path: '/post/wordplay/idiom-twist', label: 'Idiom Twist', section: 'POST' },

  { id: 'nav.settings.ai-assignments', path: '/settings/ai-assignments', label: 'AI Assignments', section: 'Settings', tabId: 'ai-assignments', navGroup: 'Agents' },
  { id: 'nav.settings.api-access', path: '/settings/api-access', label: 'API Access', section: 'Settings', tabId: 'api-access', navGroup: 'Access' },
  { id: 'nav.devtools.api-explorer', path: '/api-reference/catalog', label: 'API Explorer', section: 'Dev Tools' },
  { id: 'nav.settings.autofixer', path: '/settings/autofixer', label: 'Autofixer', section: 'Settings', tabId: 'autofixer', navGroup: 'Agents' },
  { id: 'nav.settings.backup', path: '/settings/backup', label: 'Backup', section: 'Settings', tabId: 'backup', navGroup: 'System' },
  { id: 'nav.settings.credentials', path: '/settings/credentials', label: 'Credentials', section: 'Settings', tabId: 'credentials', navGroup: 'Access' },
  { id: 'nav.settings.database', path: '/settings/database', label: 'Database', section: 'Settings', tabId: 'database', navGroup: 'System' },
  { id: 'nav.settings.features', path: '/settings/features', label: 'Features', section: 'Settings', tabId: 'features', navGroup: 'System' },
  { id: 'nav.settings.general', path: '/settings/general', label: 'General', section: 'Settings', tabId: 'general', navGroup: 'System' },
  // Local-model management is its own top-level section (#4736), which grew to
  // cover every KIND of model this install manages (#4728) — image/video
  // checkpoints, LoRAs and their training datasets, embeddings, and the
  // image-to-3D runtimes. Several ids keep a `nav.settings.*` / `nav.media.*`
  // prefix: they are opaque and stored in palette history, so renaming them
  // would orphan those entries — only the path, label and section move.
  { id: 'nav.models.comparison', path: '/models/comparison', label: 'Comparison', section: 'Models', tabId: 'comparison', navGroup: 'Evaluate' },
  { id: 'nav.models.fallbacks', path: '/models/fallbacks', label: 'Fallbacks', section: 'Models', tabId: 'fallbacks', navGroup: 'Connect' },
  { id: 'nav.models.3d', path: '/models/3d', label: '3D', section: 'Models', tabId: '3d', navGroup: 'Library' },
  { id: 'nav.models.decision-classifiers', path: '/models/decision-classifiers', label: 'Decision Classifiers', section: 'Models', tabId: 'decision-classifiers', navGroup: 'Policies' },
  { id: 'nav.models.laya-mlx', path: '/models/decision-classifiers/laya-mlx', label: 'Laya-MLX', section: 'Models' },
  { id: 'nav.models.code-reviewers', path: '/models/code-reviewers', label: 'Code Reviewers', section: 'Models', tabId: 'code-reviewers', navGroup: 'Policies', previousPaths: ['/settings/code-reviewers'] },
  // A task view of Code Reviewers, not a second sidebar destination. No tabId,
  // so the section navigator stays on Code Reviewers while ⌘K and voice can
  // still open the follow-up check directly.
  { id: 'nav.models.code-reviewers.follow-up', path: '/models/code-reviewers/follow-up', label: 'Reviewer follow-up', section: 'Models' },
  { id: 'nav.settings.embeddings', path: '/models/embeddings', label: 'Embeddings', section: 'Models', tabId: 'embeddings', navGroup: 'Library', previousPaths: ['/settings/embeddings'] },
  { id: 'nav.settings.local-llm', path: '/models/llms', label: 'Model Library', section: 'Models', tabId: 'llms', navGroup: 'Library', previousPaths: ['/settings/local-llm'] },
  { id: 'nav.models.llms.abuse', path: '/models/llms/abuse', label: 'Abuse Guard', section: 'Models', tabId: 'abuse', navGroup: 'Policies' },
  { id: 'nav.models.llms.jev', path: '/models/decision-classifiers/jev', label: 'Jev', section: 'Models', parentPath: '/models/decision-classifiers', previousPaths: ['/models/llms/jev'] },
  { id: 'nav.models.jev.try', path: '/models/decision-classifiers/jev/try', label: 'Jev Try a decision', section: 'Models' },
  { id: 'nav.models.jev.integrations', path: '/models/decision-classifiers/jev/integrations', label: 'Jev Integrations', section: 'Models' },
  { id: 'nav.models.jev.results', path: '/models/decision-classifiers/jev/results', label: 'Jev Results', section: 'Models' },
  { id: 'nav.models.jev.training', path: '/models/decision-classifiers/jev/training', label: 'Jev Training', section: 'Models' },
  { id: 'nav.models.jev.setup', path: '/models/decision-classifiers/jev/setup', label: 'Jev Setup', section: 'Models' },
  // Split out of the LLMs page (#7414): managing the SERVERS that run models is
  // a different job from browsing the weights they serve, and it was the LLMs
  // default view, not a drill-down — so it gets a sibling tab rather than a
  // pill. Declared AFTER `nav.settings.local-llm` on purpose: alias collisions
  // resolve first-declared-wins, so "ollama"/"llms" keep landing on the
  // catalog page even though this page starts those servers too.
  { id: 'nav.models.llms-runtimes', path: '/models/llms-runtimes', label: 'Runtimes', section: 'Models', tabId: 'llms-runtimes', navGroup: 'Connect', previousPaths: ['/models/llms/runtimes'] },
  { id: 'nav.media.loras', path: '/models/loras', label: 'LoRAs', section: 'Models', tabId: 'loras', navGroup: 'Library', previousPaths: ['/media/loras', '/settings/data-maintenance', '/media/training', '/media/training/:datasetId', '/models/training', '/models/training/:recordId'], preservePreviousPathSuffix: false },
  { id: 'nav.media.models', path: '/models/media', label: 'Media', section: 'Models', tabId: 'media', navGroup: 'Library', previousPaths: ['/media/models', '/media-models'] },
  { id: 'nav.models.performance', path: '/models/performance', label: 'Performance', section: 'Models', tabId: 'performance', navGroup: 'Evaluate' },
  { id: 'nav.models.performance.results', path: '/models/performance/results', label: 'Performance Results', section: 'Models' },
  { id: 'nav.models.performance.capabilities', path: '/models/performance/capabilities', label: 'Performance Capabilities', section: 'Models' },
  { id: 'nav.models.performance.agent-checks', path: '/models/performance/agent-checks', label: 'Performance Agent Checks', section: 'Models' },
  { id: 'nav.models.performance.tuning', path: '/models/performance/tuning', label: 'Performance Tuning', section: 'Models' },
  // Absorbed the Dev Tools 'Model Resources' page (#4728), so its aliases and
  // keywords live here — 'model resources' and 'downloaded models' must keep
  // resolving after the fold.
  { id: 'nav.models.status', path: '/models/status', label: 'Status', section: 'Models', tabId: 'status', navGroup: 'Operate', previousPaths: ['/system-resources/models'] },
  { id: 'nav.models.subscriptions', path: '/models/subscriptions', label: 'Subscriptions', section: 'Models', tabId: 'subscriptions', navGroup: 'Operate' },
  { id: 'nav.settings.local-llm-playground', path: '/local-llm/playground', label: 'Playground', section: 'Models', tabId: 'playground', navGroup: 'Evaluate' },
  { id: 'nav.settings.mortalloom', path: '/settings/mortalloom', label: 'MortalLoom', section: 'Settings', tabId: 'mortalloom', navGroup: 'Integrations', feature: 'health' },
  { id: 'nav.settings.openclaw', path: '/openclaw', label: 'OpenClaw', section: 'Settings', tabId: 'openclaw', navGroup: 'Integrations', feature: 'openclaw' },
  { id: 'nav.settings.orchestration', path: '/settings/orchestration', label: 'Orchestration Profiles', section: 'Settings', tabId: 'orchestration', navGroup: 'Agents' },
  { id: 'nav.settings.security', path: '/settings/security', label: 'Security', section: 'Settings', tabId: 'security', navGroup: 'Access' },
  { id: 'nav.capabilities', path: '/capabilities', label: 'Setup', section: 'Settings' },
  { id: 'nav.settings.sharing', path: '/settings/sharing', label: 'Sharing', section: 'Settings', tabId: 'sharing', navGroup: 'Access' },
  { id: 'nav.settings.software', path: '/settings/software', label: 'Software', section: 'Settings', tabId: 'software', navGroup: 'System' },
  { id: 'nav.settings.telegram', path: '/settings/telegram', label: 'Telegram', section: 'Settings', tabId: 'telegram', navGroup: 'Integrations' },
  { id: 'nav.settings.voice', path: '/settings/voice', label: 'Voice', section: 'Settings', tabId: 'voice', navGroup: 'Integrations' },
  { id: 'nav.settings.facetime', path: '/settings/voice', label: 'FaceTime Audio', section: 'Settings', feature: 'facetime' },
  { id: 'nav.settings.call-host', path: '/voice/call-host', label: 'Call Host', section: 'Settings', feature: 'facetime' },

  { id: 'nav.ambient', path: '/ambient', label: 'Ambient', section: 'Dev Tools' },
  { id: 'nav.data', path: '/data', label: 'Data', section: 'Dev Tools' },
  { id: 'nav.instances', path: '/instances', label: 'Instances', section: 'Dev Tools' },
  { id: 'nav.loops', path: '/loops', label: 'Loops', section: 'Dev Tools' },
  { id: 'nav.devtools.processes', path: '/devtools/processes', label: 'Processes', section: 'Dev Tools' },
  { id: 'nav.security', path: '/security', label: 'Security Camera', section: 'Dev Tools' },
  { id: 'nav.system-health', path: '/system-resources/overview', label: 'System Resources', section: 'Dev Tools', tabGroup: 'system-resources', tabId: 'overview', tabLabel: 'Overview', previousPaths: ['/system-health', '/system-resources'] },
  { id: 'nav.system-resources.storage', path: '/system-resources/storage', label: 'Storage Report', section: 'Dev Tools', tabGroup: 'system-resources', tabId: 'storage', tabLabel: 'Storage' },
  { id: 'nav.system-resources.queues', path: '/system-resources/queues', label: 'Active Queues', section: 'Dev Tools', tabGroup: 'system-resources', tabId: 'queues', tabLabel: 'Queues' },
  { id: 'nav.uploads', path: '/uploads', label: 'Uploads', section: 'Dev Tools' },

  { id: 'nav.wiki.overview', path: '/wiki/overview', label: 'Wiki', section: 'Brain', tabGroup: 'wiki', tabId: 'overview', tabLabel: 'Overview' },
  { id: 'nav.wiki.browse', path: '/wiki/browse', label: 'Browse', section: 'Brain', tabGroup: 'wiki', tabId: 'browse' },
  { id: 'nav.wiki.search', path: '/wiki/search', label: 'Search', section: 'Brain', tabGroup: 'wiki', tabId: 'search' },
  { id: 'nav.wiki.graph', path: '/wiki/graph', label: 'Graph', section: 'Brain', tabGroup: 'wiki', tabId: 'graph' },
  { id: 'nav.wiki.log', path: '/wiki/log', label: 'Log', section: 'Brain', tabGroup: 'wiki', tabId: 'log' },
];

// A gated entry carries `feature`: the id of the optional instance feature it
// belongs to (server/lib/instanceFeatureRegistry.js). The manifest ships the tag
// rather than dropping the entry, and the GATE IS APPLIED CLIENT-SIDE — by the
// sidebar and the ⌘K palette, which both hold the user's live feature state and
// so react to a toggle without a reload. Filtering here instead would defeat the
// manifest's HTTP caching and still leave ⌘K stale, because it caches the
// manifest for the session.
//
// Gating hides a page from those two BROWSE surfaces only. The route keeps
// working, and so does navigating to it by name — a bookmark, a direct URL, or
// voice `ui_navigate` all still resolve, the same way a disabled feature's page
// stays reachable when opened directly.
export const NAV_COMMANDS = RAW_NAV_COMMANDS.map((cmd) => {
  const feature = cmd.feature || SECTION_FEATURE.get(cmd.section);
  return feature ? { ...cmd, feature } : cmd;
});

// `tabId` marks the destinations that participate in their section's shared
// child navigation. It deliberately lives beside the route's section and
// label, rather than in a page component, so moving a destination between
// sidebar sections moves its child-nav entry with it. Commands without a
// `tabId` are still valid navigation destinations, but are nested drill-downs
// or workflow overlays rather than section-level tabs.
export const getSectionNavTabs = (section) => NAV_COMMANDS
  .filter((command) => command.section === section && command.tabId && !command.tabGroup)
  .sort((a, b) => (a.navGroup || '').localeCompare(b.navGroup || '') || a.label.localeCompare(b.label) || a.path.localeCompare(b.path))
  .map(({ tabId, label, path, feature, navGroup }) => ({
    id: tabId,
    label,
    to: path,
    ...(feature ? { feature } : {}),
    ...(navGroup ? { navGroup } : {}),
  }));

// Grouped section navigation is derived from the same tab records as the flat
// section bar. A group is presentation metadata, never a route or a second
// destination list. Groups and their destinations are alphabetized so the
// desktop navigator, expanded sidebar, and mobile row share one stable order.
export const getSectionNavGroups = (section) => {
  const groups = new Map();
  getSectionNavTabs(section).forEach((tab) => {
    if (!tab.navGroup) return;
    const groupTabs = groups.get(tab.navGroup) || [];
    groupTabs.push(tab);
    groups.set(tab.navGroup, groupTabs);
  });
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, tabs]) => ({ label, tabs }));
};

// `tabGroup` marks the destinations that make up ONE page's own local tab bar
// (Brain, Calendar, CoS, Digital Twin, Goals, Insights, Media Gen, MeatSpace,
// Messages, Music, Privacy, Sharing, System Resources, Wiki) — a different axis
// from `tabId`'s section-level child nav above. A page can sit in any sidebar
// section (Insights and Privacy both live under "Identity") without its tab
// ids colliding with a sibling page's, because uniqueness below is scoped to
// the group, not the section. Order is DECLARATION order, not alphabetical —
// pages order their own tabs deliberately (e.g. Overview first, Settings
// last), unlike the alphabetical section headers `getSectionNavTabs` builds.
// The page pairs this with a local presentation map (icon, component, …)
// keyed by `id` via `buildPageNavTabs` (client/src/lib/pageNavTabs.js), which
// throws at module load if a returned tab has no matching presentation entry.
export const getPageNavTabs = (group) => NAV_COMMANDS
  .filter((command) => command.tabGroup === group)
  .map(({ tabId, label, tabLabel, path, feature }) => ({
    id: tabId,
    label: tabLabel || label,
    to: path,
    ...(feature ? { feature } : {}),
  }));

export const getSectionNavTabForPath = (section, pathname) => {
  const normalizedPath = normalizedNavPath(pathname);
  const tabs = getSectionNavTabs(section);
  return tabs.find((tab) => normalizedNavPath(tab.to) === normalizedPath)
    || [...tabs]
      .sort((a, b) => normalizedNavPath(b.to).length - normalizedNavPath(a.to).length)
      .find((tab) => pathContainsNavRoute(normalizedPath, normalizedNavPath(tab.to)));
};

const normalizedNavPath = (pathname) => {
  const barePath = String(pathname || '').split(/[?#]/)[0];
  if (!barePath || barePath === '/') return '/';
  return barePath.replace(/\/+$/, '');
};

const pathContainsNavRoute = (pathname, routePath) => (
  pathname === routePath || pathname.startsWith(`${routePath}/`)
);

// Every command with its path pre-normalized, longest path first — so a route
// lookup is one `.find()` down a fixed list instead of a normalize-filter-sort
// of the whole manifest per call. `NAV_COMMANDS` is frozen at module load and
// never mutated, so this cannot go stale.
//
// Longest-first IS the match rule: it keeps a drill-down (`/models/llms/abuse`)
// on itself rather than on the parent whose prefix it also shares.
const NAV_COMMANDS_BY_SPECIFICITY = NAV_COMMANDS
  .map((command) => ({ command, routePath: normalizedNavPath(command.path) }))
  .sort((a, b) => b.routePath.length - a.routePath.length);

// The most specific command that OWNS a routed path, or `undefined`. `predicate`
// narrows the candidate set; both exports below are this walk plus a projection,
// so the ranking rule lives in exactly one place.
const navCommandForPath = (pathname, predicate) => {
  const normalizedPath = normalizedNavPath(pathname);
  return NAV_COMMANDS_BY_SPECIFICITY
    .find(({ command, routePath }) => predicate(command) && pathContainsNavRoute(normalizedPath, routePath))
    ?.command;
};

export const getNavCommandForPath = (pathname) => navCommandForPath(pathname, () => true);

// Find the section whose tab owns a routed page, intentionally ignoring workflow
// commands such as `/ai/fleet` that do not carry a `tabId`.
export const getNavSectionForPath = (pathname) => (
  navCommandForPath(pathname, (command) => command.tabId && !command.tabGroup)?.section || null
);

// The page a route belongs to, as a user reads it in the UI: `label` is the tab
// name ("Runtimes"), `breadcrumb` is how the sidebar path to it is spoken and
// written ("Models → Runtimes").
//
// Readiness copy derives its wording from here rather than hardcoding a
// breadcrumb beside each link, because the two drifted apart the moment a page
// moved: every local runtime's "start it from Models → LLMs" hint kept naming
// the LLMs page after its runtime controls became a sibling tab (#7414). A hint
// that links to `manageUrl` now NAMES whatever page that route resolves to, so
// the next move re-words all of them.
//
// Unlike the section lookup this considers drill-downs too, so a nested view
// reports its own page. Returns `null` for a blank path or one no command
// declares — callers drop the clause rather than inventing a page name.
export const getNavPageForPath = (pathname) => {
  if (normalizedNavPath(pathname) === '/') return null;
  const command = navCommandForPath(pathname, () => true);
  if (!command) return null;
  return { label: command.label, section: command.section, breadcrumb: `${command.section} → ${command.label}` };
};

export const PROVIDERS_PAGE_BREADCRUMB = getNavPageForPath(PROVIDERS_PAGE_PATH)?.breadcrumb ?? 'the Providers page';

// Expand the `{page}` token user-facing copy writes instead of a breadcrumb,
// resolved from `runtime.manageUrl` (or any object carrying that field) via
// `getNavPageForPath` above — same reason as that lookup: the sentence and the
// link it describes must name one page, decided by the route, not typed twice.
// A `manageUrl` with no page (or `null`, for a runtime PortOS has no page for)
// falls back to generic prose rather than shipping a literal `{page}`.
export const expandPageToken = (text, runtime) => (
  typeof text === 'string' && text.includes('{page}')
    ? text.replaceAll('{page}', getNavPageForPath(runtime?.manageUrl)?.breadcrumb || 'its management page')
    : text
);

// Every feature id this manifest gates on, for the registry-drift guard.
export const NAV_FEATURE_IDS = [...new Set(NAV_COMMANDS.map((c) => c.feature).filter(Boolean))].sort();

if (!import.meta.env?.PROD) {
  const seenIds = new Set();
  for (const cmd of NAV_COMMANDS) {
    if (!cmd.id || !cmd.path || !cmd.label || !cmd.section) {
      throw new Error(`navManifest: malformed entry ${JSON.stringify(cmd)}`);
    }
    if (!cmd.path.startsWith('/')) {
      throw new Error(`navManifest: path must start with / — got "${cmd.path}" for ${cmd.id}`);
    }
    if (cmd.tabId !== undefined && (typeof cmd.tabId !== 'string' || !cmd.tabId.trim())) {
      throw new Error(`navManifest: tabId must be a non-empty string — got "${cmd.tabId}" for ${cmd.id}`);
    }
    if (cmd.tabGroup !== undefined && (typeof cmd.tabGroup !== 'string' || !cmd.tabGroup.trim())) {
      throw new Error(`navManifest: tabGroup must be a non-empty string — got "${cmd.tabGroup}" for ${cmd.id}`);
    }
    if (cmd.tabGroup !== undefined && !cmd.tabId) {
      throw new Error(`navManifest: tabGroup requires tabId — ${cmd.id} declares tabGroup "${cmd.tabGroup}" with no tabId`);
    }
    if (cmd.navGroup !== undefined && (typeof cmd.navGroup !== 'string' || !cmd.navGroup.trim())) {
      throw new Error(`navManifest: navGroup must be a non-empty string — got "${cmd.navGroup}" for ${cmd.id}`);
    }
    if (cmd.tabLabel !== undefined && (typeof cmd.tabLabel !== 'string' || !cmd.tabLabel.trim())) {
      throw new Error(`navManifest: tabLabel must be a non-empty string — got "${cmd.tabLabel}" for ${cmd.id}`);
    }
    if (cmd.parentPath !== undefined) {
      if (typeof cmd.parentPath !== 'string' || !cmd.parentPath.startsWith('/')) {
        throw new Error(`navManifest: parentPath must start with / — got "${cmd.parentPath}" for ${cmd.id}`);
      }
      if (!RAW_NAV_COMMANDS.some((c) => c.path === cmd.parentPath)) {
        throw new Error(`navManifest: parentPath "${cmd.parentPath}" not found for ${cmd.id}`);
      }
    }
    if (seenIds.has(cmd.id)) throw new Error(`navManifest: duplicate id ${cmd.id}`);
    seenIds.add(cmd.id);
  }

  // `tabId` uniqueness is scoped to whichever axis owns it: a page's `tabGroup`
  // when it has one (Insights and Privacy can both use id "overview" — they're
  // different groups sharing the "Identity" section), otherwise the legacy
  // per-section scope `getSectionNavTabs` relies on (Settings/Models).
  const tabIdScopes = new Map();
  for (const command of NAV_COMMANDS) {
    if (!command.tabId) continue;
    const scopeKey = command.tabGroup ? `group:${command.tabGroup}` : `section:${command.section}`;
    const scopedIds = tabIdScopes.get(scopeKey) || new Set();
    if (scopedIds.has(command.tabId)) {
      const scopeDesc = command.tabGroup ? `tabGroup "${command.tabGroup}"` : `section ${command.section}`;
      throw new Error(`navManifest: duplicate tabId "${command.tabId}" in ${scopeDesc}`);
    }
    scopedIds.add(command.tabId);
    tabIdScopes.set(scopeKey, scopedIds);
  }
}

export const normalizeLabel = (s) => (s || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?:;,"']+$/, '');
