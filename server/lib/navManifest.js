// Single source of truth for PortOS navigation. Consumed by the sidebar,
// server/services/voice/tools.js#ui_navigate, and the Cmd+K palette.
// Entry: { id, path, label, section, aliases?, keywords?, previousPaths?, preservePreviousPathSuffix? }.
// See AGENTS.md "Command Palette & Voice Nav" for the contract.
//
// `previousPaths` lists every path this page has ANSWERED TO BEFORE — including
// its parameterized drill-downs, written with the OLD route's param name (the
// guard matches the `<Route path>` literally, and a deep link into a detail view
// is exactly the kind of bookmark that breaks silently). Bookmarks,
// stale palette history, and links held by other installs all still say the old
// path, so a move that drops the redirect 404s them — and nothing else notices,
// because every other guard here only looks at where a route points now. Declare
// the old path when you move a page and `navManifest.test.js` proves App.jsx
// still redirects it; the data lives next to the thing that moved, so the next
// move needs no edit to the test.

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

const RAW_NAV_COMMANDS = [
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main', aliases: ['dashboard', 'home'], keywords: ['overview', 'start'] },
  { id: 'nav.review-hub', path: '/review', label: 'Review Hub', section: 'Main', aliases: ['review', 'review-hub'] },
  { id: 'nav.eidoverse', path: '/eidoverse', label: 'Eidoverse', section: 'Main', feature: 'eidoverse', previousPaths: ['/openworld', '/city'], preservePreviousPathSuffix: false, aliases: ['eidoverse', 'eidoverse-worlds', 'worlds', 'openworld', 'open-world', 'city'], keywords: ['3d', 'world', 'agents', 'spatial', 'managed app', 'private environment'] },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'Main', aliases: ['apps'] },
  // Submodules are per-app (a tab on the app detail page), so this entry is
  // explicitly PortOS's own — the only repo whose app id is a fixed constant.
  // Every other app reaches its tab from /apps/<id>/submodules.
  { id: 'nav.apps.submodules', path: `/apps/${PORTOS_APP_ID}/submodules`, label: 'PortOS Submodules', section: 'Apps', previousPaths: ['/devtools/submodules'], aliases: ['submodules', 'devtools-submodules', 'portos-submodules'], keywords: ['git', 'slashdo', 'vendored', 'update submodule'] },
  { id: 'nav.templates', path: '/templates', label: 'Templates', section: 'Main', aliases: ['templates', 'app-templates'], keywords: ['app template', 'create app', 'pre-configured', 'starter'] },

  { id: 'nav.catalog', path: '/catalog', label: 'Catalog', section: 'Create', aliases: ['catalog', 'ingredients', 'cast', 'creative-catalog'], keywords: ['character', 'place', 'object', 'idea', 'scene', 'concept', 'inventory', 'reference', 'creative'] },
  { id: 'nav.catalog.ingest', path: '/catalog/ingest', label: 'Catalog Ingest', section: 'Create', aliases: ['catalog-ingest', 'ingest', 'paste-scrap', 'extract-ingredients'], keywords: ['paste', 'snippet', 'scene', 'idea', 'extract', 'scrap', 'import-catalog'] },
  { id: 'nav.catalog.settings', path: '/catalog?settings=1', label: 'Catalog Types', section: 'Create', previousPaths: ['/settings/catalog'], aliases: ['catalog settings', 'catalog-settings', 'settings-catalog', 'catalog-types'], keywords: ['catalog', 'types', 'labels', 'character', 'place', 'object', 'taxonomy'] },
  { id: 'nav.media', path: '/media', label: 'Media Gen', section: 'Create', aliases: ['media', 'media-gen', 'mediagen', 'generate'], keywords: ['image', 'video', 'render', 'art', 'movie'] },
  { id: 'nav.media.image', path: '/media/image', label: 'Image', section: 'Create', previousPaths: ['/image-gen'], aliases: ['image-gen', 'imagegen', 'generate-image', 'sd', 'stable-diffusion'], keywords: ['stable diffusion', 'render', 'art', 'picture', 'photo', 'draw', 'flux', 'mflux'] },
  { id: 'nav.media.video', path: '/media/video', label: 'Video', section: 'Create', previousPaths: ['/video-gen'], aliases: ['video-gen', 'videogen', 'generate-video', 'ltx'], keywords: ['video', 'animate', 'movie', 'clip', 'ltx'] },
  { id: 'nav.media.history', path: '/media/history', label: 'Media History', section: 'Create', previousPaths: ['/media-history'], aliases: ['media-history', 'video-history'], keywords: ['videos', 'gallery', 'stitch'] },
  { id: 'nav.media.annotate', path: '/media/annotate', label: 'Annotate', section: 'Create', previousPaths: ['/annotate', '/annotate/:mediaKey'], aliases: ['annotate', 'media-annotate', 'sketch', 'draw-over', 'markup'], keywords: ['annotation', 'sketch', 'draw', 'markup', 'scribble', 'label', 'canvas', 'overlay', 'stroke'] },
  { id: 'nav.media.collections', path: '/media/collections', label: 'Collections', section: 'Create', aliases: ['collections', 'media-collections', 'stacks', 'projects'], keywords: ['bucket', 'group', 'project', 'album', 'organize'] },
  { id: 'nav.create.creative-director', path: '/creative-director', label: 'Creative Director', section: 'Create', previousPaths: ['/media/creative-director', '/media/creative-director/:id', '/media/creative-director/:id/:tab'], aliases: ['creative-director', 'creative', 'director', 'producer', 'orchestrator', 'long-form', 'episode'], keywords: ['story', 'episode', 'narrative', 'agent', 'auto-video', 'long-form', 'directive', 'production plan', 'plan board', 'orchestrator', 'studio', 'producer'] },
  { id: 'nav.create.creative-commission', path: '/creative-commission', label: 'Creative Commissions', section: 'Create', aliases: ['creative-commission', 'commissions', 'commission', 'creation-engine', 'autonomous-creation', 'standing-brief', 'recurring-brief'], keywords: ['schedule', 'recurring', 'nightly', 'brief', 'autonomous', 'creation engine', 'cron', 'feedback', 'taste', 'standing commission', 'auto-generate'] },
  { id: 'nav.create.fableloom', path: '/fableloom', label: 'FableLoom', section: 'Create', aliases: ['fableloom', 'fable-loom', 'loom', 'branching-narrative', 'interactive-story', 'branching-story'], keywords: ['branching', 'interactive', 'narrative', 'intent', 'endings', 'reader', 'scene', 'node', 'graph', 'nonlinear', 'play', 'story graph'] },
  { id: 'nav.create.game', path: '/game', label: 'Game', section: 'Create', aliases: ['game', 'games', 'game-studio'], keywords: ['managed app', 'sprite', 'atlas', 'music', 'asset bundle', 'manifest', 'feedback'] },
  { id: 'nav.create.music-video', path: '/music-video', label: 'Music Video', section: 'Create', previousPaths: ['/media/music-video', '/media/music-video/:projectId'], aliases: ['music-video', 'musicvideo', 'music video', 'mv', 'sync-to-beat'], keywords: ['music', 'beat', 'sync', 'audio-reactive', 'director', 'scene board', 'tempo', 'choreography'] },
  { id: 'nav.create.mood-boards', path: '/mood-boards', label: 'Mood Boards', section: 'Create', aliases: ['mood-boards', 'mood-board', 'moodboard', 'mood', 'inspiration', 'references'], keywords: ['inspiration', 'reference', 'pin', 'visual', 'canvas', 'collect', 'pinboard', 'palette', 'ideas'] },
  // Promoted out of the Media Gen tabs to a top-level Create page (#2930).
  // The id stays `nav.media.sprites` — it's opaque and stored in palette
  // history, so renaming it would orphan those entries.
  { id: 'nav.media.sprites', path: '/sprites', label: 'Sprites', section: 'Create', previousPaths: ['/media/sprites', '/media/sprites/:id'], aliases: ['sprites', 'sprite', 'sprite-manager', 'sprite-sheets'], keywords: ['sprite sheet', 'atlas', 'game art', 'pixel art', 'character animation', 'walk cycle', 'anchors'] },
  { id: 'nav.media.timeline', path: '/media/timeline', label: 'Timeline', section: 'Create', aliases: ['timeline', 'video-timeline', 'editor'], keywords: ['edit', 'trim', 'composite', 'stitch', 'cut', 'compose'] },
  { id: 'nav.media.threejs', path: '/media/threejs', label: 'Three.js Models', section: 'Create', aliases: ['threejs', 'three-js', '3d-models', 'image-to-3d', 'img2threejs'], keywords: ['procedural', '3d', 'mesh', 'model', 'gallery', 'webgl', 'preview'] },
  { id: 'nav.create.3d', path: '/3d', label: '3D', section: 'Create', previousPaths: ['/media/3d', '/media/3d/:id'], aliases: ['3d', 'image-to-mesh', 'mesh', 'trellis', 'pixal3d', 'neural-3d'], keywords: ['trellis', 'pixal3d', 'pixal', 'glb', 'mesh', 'photogrammetry', 'neural', 'image to 3d', 'render', 'generate', 'pbr'] },
  { id: 'nav.create.authors', path: '/authors', label: 'Authors', section: 'Create', aliases: ['authors', 'author', 'byline', 'author-persona', 'writer-persona'], keywords: ['author', 'byline', 'pen name', 'persona', 'writing style', 'bio', 'headshot', 'cover', 'book author'] },
  { id: 'nav.create.universe-builder', path: '/universes', label: 'Universes', section: 'Create', previousPaths: ['/media/universe-builder', '/media/universe-builder/:universeId', '/universe-builder', '/universe-builder/:universeId'], aliases: ['universes', 'universe', 'universe-builder', 'worldbuilder', 'worldbuild', 'world', 'lore', 'universe-canon', 'canon'], keywords: ['style template', 'sci-fi', 'fantasy', 'concept art', 'batch render', 'variations', 'characters', 'settings', 'objects', 'canon entries', 'list', 'manage'] },
  { id: 'nav.create.importer', path: '/importer', label: 'Importer', section: 'Create', aliases: ['importer', 'import'], keywords: ['paste', 'screenplay', 'novel', 'short story', 'comic script', 'analyze', 'reverse-engineer', 'extract'] },
  { id: 'nav.create.pipeline', path: '/pipeline', label: 'Series Pipeline', section: 'Create', aliases: ['series', 'pipeline', 'production', 'series-pipeline', 'production-pipeline'], keywords: ['series', 'issue', 'episode', 'comic', 'script', 'prose', 'storyboard', 'narrative', 'workflow'] },
  { id: 'nav.create.pipeline.editorial-checks', path: '/pipeline/editorial-checks', label: 'Editorial Checks', section: 'Create', aliases: ['editorial-checks', 'editorial', 'checks', 'editorial-review', 'content-checks', 'manuscript-checks'], keywords: ['editorial', 'check', 'review', 'naming', 'exposition', 'info-dumping', 'continuity', 'quality', 'lint', 'triage', 'findings', 'deterministic', 'llm'] },
  { id: 'nav.create.pipeline-continuity-bible', path: '/pipeline', label: 'Series Continuity', section: 'Create', aliases: ['continuity-bible', 'continuity', 'series-continuity', 'facts-ledger', 'established-facts', 'canon-ledger'], keywords: ['continuity', 'bible', 'facts', 'ledger', 'established', 'knowledge-leak', 'contradiction', 'timeline', 'wardrobe', 'prop', 'physical-traits', 'who-knows-what'] },
  { id: 'nav.create.pipeline-voice-fingerprint', path: '/pipeline', label: 'Voice Fingerprint', section: 'Create', aliases: ['voice-fingerprint', 'voice-drift', 'fingerprint', 'voice-matrix', 'prose-fingerprint'], keywords: ['voice', 'drift', 'fingerprint', 'matrix', 'style', 'prose', 'sentence-rhythm', 'outlier', 'metrics', 'deterministic', 'editorial', 'consistency', 'register', 'vocabulary-wells'] },
  { id: 'nav.create.pipeline-export', path: '/pipeline', label: 'Prose Series Export', section: 'Create', aliases: ['export', 'prose-export', 'series-export', 'manuscript-export', 'epub', 'ebook', 'publish'], keywords: ['export', 'manuscript', 'epub', 'ebook', 'pdf', 'print', 'interior', 'trade paperback', 'compiled', 'download', 'publish', 'trim size', 'title page', 'book'] },
  { id: 'nav.create.sharing', path: '/sharing', label: 'Sharing', section: 'Create', aliases: ['sharing', 'share', 'buckets', 'share-buckets'], keywords: ['google drive', 'dropbox', 'icloud', 'syncthing', 'export', 'import', 'collaborate', 'federation', 'peer', 'cross-network'] },
  { id: 'nav.create.sharing-duplicates', path: '/sharing/duplicates', label: 'Duplicates', section: 'Create', aliases: ['duplicates', 'duplicate-universes', 'duplicate-series', 'dedupe', 'merge-duplicates'], keywords: ['duplicate', 'merge', 'rename', 'same name', 'two copies', 'reconcile', 'collision'] },
  { id: 'nav.create.start-story', path: '/start-story', label: 'Start a Story', section: 'Create', aliases: ['start-story', 'start-a-story', 'start', 'begin-story', 'create-story', 'onramp'], keywords: ['start here', 'begin', 'idea', 'import', 'prose', 'story builder', 'writers room', 'importer', 'how to start', 'new', 'front door', 'choose'] },
  { id: 'nav.create.story-builder', path: '/story-builder', label: 'Story Builder', section: 'Create', aliases: ['story-builder', 'storybuilder', 'guided', 'new-story', 'story-wizard'], keywords: ['idea', 'universe', 'arc', 'reader map', 'guided', 'wizard', 'linear', 'lock', 'front door', 'episode', 'series'] },
  { id: 'nav.create.rounds', path: '/rounds', label: 'Rounds', section: 'Create', aliases: ['rounds', 'round', 'songs', 'song', 'a-cappella', 'acappella', 'sing'], keywords: ['round', 'song', 'lyrics', 'melody', 'harmony', 'dirge', 'ballad', 'a cappella', 'vocal', 'choir', 'singing', 'arrangement', 'quodlibet', '500 miles'] },
  { id: 'nav.create.rounds-guide', path: '/rounds/guide', label: 'Rounds Guide', section: 'Create', aliases: ['rounds-guide', 'round-guide', 'songs-guide', 'song-guide', 'singing-guide', 'round-learning'], keywords: ['rhythm shapes', 'dirge', 'voice layers', 'harmony', 'notation', 'lead sheet', 'solfege', 'learn round', 'learn song', 'a cappella', 'singing help'] },
  { id: 'nav.create.music', path: '/music', label: 'Music', section: 'Create', aliases: ['music', 'music-studio', 'generate-music'], keywords: ['music generation', 'ace-step', 'acestep', 'musicgen', 'audioldm', 'album', 'track', 'single', 'album art', 'artist', 'song generation', 'audio', 'beat', 'producer'] },
  { id: 'nav.create.music-generate', path: '/music/generate', label: 'Music Designer', section: 'Create', aliases: ['music-generate', 'music-designer', 'design-music', 'write-a-song', 'make-music'], keywords: ['generate music', 'music designer', 'describe music', 'enrich prompt', 'write lyrics', 'lyrics', 'ace-step', 'reference track', 'vibe', 'step by step', 'wizard'] },
  { id: 'nav.create.music-artists', path: '/music/artists', label: 'Music Artists', section: 'Create', aliases: ['music-artists', 'artists', 'artist', 'artist-persona', 'musician', 'band'], keywords: ['artist persona', 'musician', 'band', 'byline', 'portrait', 'genre', 'musical style', 'stage name'] },
  { id: 'nav.create.music-albums', path: '/music/albums', label: 'Music Albums', section: 'Create', aliases: ['albums', 'album', 'music-albums', 'discography', 'lp', 'ep'], keywords: ['album', 'cover art', 'tracklist', 'release', 'discography', 'record'] },
  { id: 'nav.create.music-tracks', path: '/music/tracks', label: 'Music Tracks', section: 'Create', aliases: ['tracks', 'track', 'music-tracks', 'singles', 'songs-audio'], keywords: ['track', 'single', 'audio', 'recording', 'lyrics', 'mp3', 'wav', 'generate track'] },
  { id: 'nav.create.sharing-conflicts', path: '/sharing/conflicts', label: 'Conflicts', section: 'Create', aliases: ['conflicts', 'sync-conflicts', 'edit-conflicts', 'conflict-journal'], keywords: ['conflict', 'overwrite', 'lost edit', 'restore', 'merge fields', 'last write wins', 'diverged', 'recover'] },
  { id: 'nav.media.settings', path: '/media/image?settings=1', label: 'Media Gen Settings', section: 'Create', aliases: ['media-settings', 'image-gen-settings', 'sd-settings', 'video-gen-settings'] },
  { id: 'nav.writers-room', path: '/writers-room', label: 'Writers Room', section: 'Create', aliases: ['writers-room', 'writersroom', 'writer', 'write', 'studio', 'novel'], keywords: ['prose', 'screenplay', 'story', 'draft', 'manuscript', 'literary', 'novel', 'short story'] },
  { id: 'nav.writers-room.guide', path: '/writers-room/guide', label: 'Writers Room Guide', section: 'Create', aliases: ['writers-room-guide', 'writing-guide', 'writing-rules', 'word-count', 'length-targets'], keywords: ['microfiction', 'flash fiction', 'short story', 'novelette', 'novella', 'novel length', 'word count', 'character count', 'book length', 'craft', 'writing advice', 'emotional roadmap', 'documentation', 'help'] },
  { id: 'nav.settings.prompts', path: '/prompts', label: 'Prompts', section: 'Settings', aliases: ['prompts'] },
  { id: 'nav.settings.providers', path: '/ai', label: 'Providers', section: 'Models', aliases: ['providers', 'ai-providers'] },
  { id: 'nav.settings.fleet-llm', path: '/ai/fleet', label: 'Fleet LLM Setup', section: 'Settings', aliases: ['fleet-llm', 'gpu-host', 'remote-ai-provider'], keywords: ['3090', 'tailscale', 'vllm', 'qwen', 'coding model', 'dedicated host'] },

  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Inbox', section: 'Brain', aliases: ['brain', 'brain-inbox', 'inbox'] },
  { id: 'nav.brain.config', path: '/brain/config', label: 'Config', section: 'Brain', aliases: ['brain-config'] },
  { id: 'nav.brain.daily-log', path: '/brain/daily-log', label: 'Daily Log', section: 'Brain', aliases: ['daily-log', 'journal'] },
  { id: 'nav.brain.digest', path: '/brain/digest', label: 'Digest', section: 'Brain', aliases: ['brain-digest'] },
  { id: 'nav.brain.feeds', path: '/brain/feeds', label: 'Feeds', section: 'Brain', aliases: ['brain-feeds', 'feeds', 'rss'], keywords: ['rss', 'subscriptions'] },
  { id: 'nav.brain.graph', path: '/brain/graph', label: 'Graph', section: 'Brain', aliases: ['brain-graph'] },
  { id: 'nav.brain.ideas', path: '/brain/ideas', label: 'Ideas', section: 'Brain', aliases: ['brain-ideas', 'ideas'], keywords: ['brainstorm', 'creative', 'thought', 'concept'] },
  { id: 'nav.brain.idealoom', path: '/brain/ideas?view=lists', label: 'IdeaLoom Lists', section: 'Brain', aliases: ['idealoom', 'idea-loom', 'idealoom-lists'], keywords: ['obsidian', 'vault', 'ordered list', 'local lists'] },
  { id: 'nav.brain.import', path: '/brain/import', label: 'Import', section: 'Brain', aliases: ['brain-import', 'import-chatgpt', 'chatgpt-import'], keywords: ['chatgpt', 'openai', 'export', 'third-party'] },
  { id: 'nav.brain.links', path: '/brain/links', label: 'Links', section: 'Brain', aliases: ['brain-links'] },
  { id: 'nav.brain.memory', path: '/brain/memory', label: 'Memory', section: 'Brain', aliases: ['brain-memory', 'memory'] },
  { id: 'nav.brain.notes', path: '/brain/notes', label: 'Notes', section: 'Brain', aliases: ['brain-notes', 'notes'] },
  { id: 'nav.rapid-reader', path: '/rapid-reader', label: 'Rapid Reader', section: 'Brain', aliases: ['rapid-reader', 'speed-reader', 'rsvp', 'spritz'], keywords: ['speed reading', 'rapid reading', 'rsvp', 'spritz', 'word per minute', 'wpm', 'focal'] },
  // No 'songs'/'song' aliases — those already resolve to nav.create.rounds (first-declared wins).
  { id: 'nav.brain.songbook', path: '/songbook', label: 'SongBook', section: 'Brain', aliases: ['songbook', 'song-book', 'tabs', 'chords', 'guitar-tabs'], keywords: ['guitar', 'tab', 'tablature', 'chord chart', 'lyrics', 'sheet music', 'repertoire', 'autoscroll'] },
  { id: 'nav.brain.trust', path: '/brain/trust', label: 'Trust', section: 'Brain', aliases: ['brain-trust'] },

  { id: 'nav.calendar.agenda', path: '/calendar/agenda', label: 'Agenda', section: 'Calendar', aliases: ['calendar', 'agenda'] },
  { id: 'nav.calendar.config', path: '/calendar/config', label: 'Config', section: 'Calendar', aliases: ['calendar-config'] },
  { id: 'nav.calendar.day', path: '/calendar/day', label: 'Day', section: 'Calendar', aliases: ['calendar-day'] },
  { id: 'nav.calendar.week', path: '/calendar/week', label: 'Week', section: 'Calendar', aliases: ['calendar-week'] },
  { id: 'nav.calendar.month', path: '/calendar/month', label: 'Month', section: 'Calendar', aliases: ['calendar-month'] },
  { id: 'nav.calendar.lifetime', path: '/calendar/lifetime', label: 'Lifetime', section: 'Calendar', aliases: ['calendar-lifetime'] },
  { id: 'nav.calendar.review', path: '/calendar/review', label: 'Review', section: 'Calendar', aliases: ['calendar-review'] },
  { id: 'nav.calendar.sync', path: '/calendar/sync', label: 'Sync', section: 'Calendar', aliases: ['calendar-sync'] },

  { id: 'nav.cos.tasks', path: '/cos/tasks', label: 'Tasks', section: 'Chief of Staff', aliases: ['tasks', 'cos', 'cos-tasks', 'chief-of-staff'] },
  { id: 'nav.cos.agents', path: '/cos/agents', label: 'Agents', section: 'Chief of Staff', aliases: ['agents', 'cos-agents'] },
  { id: 'nav.cos.briefing', path: '/cos/briefing', label: 'Briefing', section: 'Chief of Staff', aliases: ['briefing', 'cos-briefing'] },
  { id: 'nav.cos.config', path: '/cos/config', label: 'Config', section: 'Chief of Staff', aliases: ['cos-config'] },
  { id: 'nav.cos.digest', path: '/cos/digest', label: 'Digest', section: 'Chief of Staff', aliases: ['cos-digest'] },
  { id: 'nav.feature-agents', path: '/feature-agents', label: 'Feature Agents', section: 'Chief of Staff', aliases: ['feature-agents'] },
  { id: 'nav.cos.gsd', path: '/cos/gsd', label: 'GSD', section: 'Chief of Staff', feature: 'gsd', aliases: ['gsd', 'cos-gsd'] },
  { id: 'nav.cos.health', path: '/cos/health', label: 'Health', section: 'Chief of Staff', aliases: ['cos-health', 'health'] },
  { id: 'nav.cos.learning', path: '/cos/learning', label: 'Learning', section: 'Chief of Staff', aliases: ['cos-learning'] },
  { id: 'nav.cos.memory', path: '/cos/memory', label: 'Memory', section: 'Chief of Staff', aliases: ['cos-memory'] },
  { id: 'nav.cos.mind', path: '/cos/mind', label: 'Mind', section: 'Chief of Staff', aliases: ['cos-mind', 'persistent-mind', 'mind-chat'], keywords: ['persistent mind', 'chat', 'annotation', 'resident mind', 'conversation'] },
  { id: 'nav.cos.mind-tools', path: '/cos/mind?panel=tools', label: 'Mind Tools', section: 'Chief of Staff', previousPaths: ['/cos/tools', '/cos/mind/tools'], aliases: ['mind-tools', 'persistent-mind-tools', 'tools-access'], keywords: ['persistent mind', 'tools', 'access', 'permissions', 'authority', 'capabilities'] },
  { id: 'nav.cos.runs', path: '/cos/runs', label: 'Runs', section: 'Chief of Staff', previousPaths: ['/devtools/runs'], aliases: ['runs', 'ai-runs', 'cos-runs', 'recent-runs', 'run-history'], keywords: ['runs', 'run history', 'recent runs', 'ai runs', 'agent runs', 'failed runs'] },
  { id: 'nav.cos.run-events', path: '/cos/run-events', label: 'Run Events', section: 'Chief of Staff', aliases: ['run-events', 'cos-run-events', 'run-event-ledger', 'lifecycle-events'], keywords: ['run events', 'lifecycle', 'ledger', 'replay', 'diagnostics', 'orphaned', 'handoff', 'reconnect', 'interrupted', 'why did this run fail'] },
  { id: 'nav.cos.schedule', path: '/cos/schedule', label: 'Schedule', section: 'Chief of Staff', aliases: ['schedule', 'cos-schedule'] },
  { id: 'nav.social-agents', path: '/agents', label: 'Social Agents', section: 'Chief of Staff', aliases: ['social-agents'] },
  // The page at /cos/workflow is now the Schedule Timeline (launch-order
  // visualization + inline schedule editor). The `workflow` aliases are kept
  // for muscle memory; the bare `timeline` alias stays with /media/timeline.
  { id: 'nav.cos.workflow', path: '/cos/workflow', label: 'Timeline', section: 'Chief of Staff', aliases: ['workflow', 'cos-workflow', 'cos-timeline', 'schedule-timeline'], keywords: ['timeline', 'schedule', 'launch order', 'run order', 'gantt', 'upcoming runs', 'overlap', 'dependencies'] },
  { id: 'nav.cos.productivity', path: '/cos/productivity', label: 'Productivity', section: 'Chief of Staff', aliases: ['cos-productivity', 'work-patterns', 'streaks'] },

  { id: 'nav.messages.inbox', path: '/messages/inbox', label: 'Inbox', section: 'Comms', aliases: ['messages', 'comms', 'comms-inbox'], keywords: ['comms', 'email', 'inbox'] },
  { id: 'nav.messages.drafts', path: '/messages/drafts', label: 'Drafts', section: 'Comms', aliases: ['drafts', 'comms-drafts'], keywords: ['comms'] },
  { id: 'nav.messages.imessage', path: '/messages/imessage', label: 'iMessage', section: 'Comms', previousPaths: ['/imessage'], aliases: ['imessage', 'i-message', 'apple-messages', 'comms-imessage'], keywords: ['comms', 'imessage', 'sms', 'text messages', 'chat.db', 'blocklist', 'spam'] },
  { id: 'nav.messages.signal', path: '/messages/signal', label: 'Signal', section: 'Comms', previousPaths: ['/settings/signal'], aliases: ['signal', 'signal-desktop', 'comms-signal', 'signal-settings'], keywords: ['comms', 'signal', 'signal desktop', 'messages', 'sqlcipher', 'chat', 'tribe', 'timeline', 'encrypted', 'keychain'] },
  { id: 'nav.messages.contacts', path: '/messages/contacts', label: 'Contacts', section: 'Comms', previousPaths: ['/settings/contacts'], aliases: ['contacts', 'address-book', 'comms-contacts', 'settings-contacts'], keywords: ['comms', 'contacts', 'address book', 'phone', 'email', 'tribe', 'imessage', 'names', 'resolve'] },
  // Ingestion config is a drawer over the iMessage manager (?settings=1), not a
  // Settings page — the settings-* aliases stay so "open iMessage settings" still lands.
  { id: 'nav.messages.imessage-settings', path: '/messages/imessage?settings=1', label: 'iMessage Settings', section: 'Comms', aliases: ['settings-imessage', 'imessage-settings', 'imessage-sync'], keywords: ['imessage', 'sync', 'chat.db', 'sms', 'texts', 'tribe', 'timeline', 'full disk access'] },
  { id: 'nav.messages.config', path: '/messages/config', label: 'Config', section: 'Comms', aliases: ['messages-config', 'comms-config'], keywords: ['comms'] },
  { id: 'nav.messages.sync', path: '/messages/sync', label: 'Sync', section: 'Comms', aliases: ['messages-sync', 'comms-sync'], keywords: ['comms'] },
  { id: 'nav.stacker-news', path: '/stacker-news', label: 'Stacker News', section: 'Comms', aliases: ['stacker-news', 'stacker', 'sn'], keywords: ['comms', 'community', 'territory', 'moderation', 'stewardship'] },
  { id: 'nav.x', path: '/x', label: 'X', section: 'Comms', aliases: ['x', 'x-com', 'twitter', 'comms-x'], keywords: ['comms', 'social', 'reach', 'engagement', 'shadowban', 'diagnostics'] },
  { id: 'nav.timeline', path: '/timeline', label: 'Timeline', section: 'Brain', aliases: ['activity-timeline', 'activity', 'my-day', 'life-log', 'life-timeline'], keywords: ['human activity', 'life log', 'timeline', 'messages', 'calendar', 'history', 'what did i do', 'daily', 'import', 'backfill', 'whatsapp', 'spotify', 'discord', 'youtube'] },
  { id: 'nav.tribe', path: '/tribe', label: 'Tribe', section: 'Brain', aliases: ['tribe', 'relationships', 'relationship-manager', 'people'], keywords: ['dunbar', 'friends', 'family', 'network', 'social graph', 'care cadence'] },
  // Moved out of Settings into Brain (alongside Timeline, which these feed) —
  // ids kept stable since they're opaque, persisted palette-history values;
  // only the path and section move, per the /models/* precedent above.
  { id: 'nav.settings.spotify', path: '/brain/spotify', label: 'Spotify', section: 'Brain', previousPaths: ['/settings/spotify'], aliases: ['settings-spotify', 'spotify', 'spotify-settings', 'brain-spotify'], keywords: ['spotify', 'music', 'listening', 'recently played', 'oauth', 'timeline', 'taste', 'media'] },
  { id: 'nav.settings.youtube', path: '/brain/youtube', label: 'YouTube', section: 'Brain', previousPaths: ['/settings/youtube'], aliases: ['settings-youtube', 'youtube', 'youtube-settings', 'brain-youtube'], keywords: ['youtube', 'watch history', 'video', 'scrape', 'takeout', 'timeline', 'taste', 'media'] },

  { id: 'nav.devtools.agents', path: '/devtools/agents', label: 'AI Agents', section: 'Dev Tools', aliases: ['ai-agents', 'devtools'] },
  { id: 'nav.browser', path: '/browser', label: 'Browser', section: 'Dev Tools', aliases: ['browser'] },
  { id: 'nav.devtools.runner', path: '/devtools/runner', label: 'Code', section: 'Dev Tools', aliases: ['devtools-runner'] },
  { id: 'nav.devtools.datadog', path: '/devtools/datadog', label: 'DataDog', section: 'Dev Tools', feature: 'datadog', previousPaths: ['/datadog'], aliases: ['datadog', 'devtools-datadog'] },
  { id: 'nav.devtools.flows', path: '/devtools/flows', label: 'Flows', section: 'Dev Tools', aliases: ['flows', 'integration-flows', 'workflows'], keywords: ['architecture', 'diagram', 'data flow', 'integrations', 'how it works'] },
  { id: 'nav.devtools.github', path: '/devtools/github', label: 'GitHub', section: 'Dev Tools', aliases: ['github', 'devtools-github'] },
  { id: 'nav.devtools.history', path: '/devtools/history', label: 'History', section: 'Dev Tools', aliases: ['devtools-history'] },
  { id: 'nav.devtools.image-clean', path: '/devtools/image-clean', label: 'Image Cleaner', section: 'Dev Tools', aliases: ['image-clean', 'image-cleaner'], keywords: ['metadata', 'c2pa', 'content-credentials', 'sharp', 'denoise'] },
  { id: 'nav.devtools.jira', path: '/devtools/jira', label: 'JIRA', section: 'Dev Tools', feature: 'jira', previousPaths: ['/jira'], aliases: ['jira', 'devtools-jira'] },
  { id: 'nav.devtools.jira-reports', path: '/devtools/jira/reports', label: 'JIRA Reports', section: 'Dev Tools', feature: 'jira', aliases: ['jira-reports'] },
  { id: 'nav.devtools.quota-burn', path: '/devtools/quota-burn', label: 'Quota Burn', section: 'Dev Tools', aliases: ['quota-burn', 'burn-quota', 'quota'], keywords: ['subscription', 'usage', 'reset window', 'spend quota', 'claude', 'codex', 'grok', 'agy', 'burn'] },
  { id: 'nav.shell', path: '/shell', label: 'Shell', section: 'Dev Tools', aliases: ['shell', 'terminal'] },
  { id: 'nav.devtools.usage', path: '/devtools/usage', label: 'Usage', section: 'Models', aliases: ['devtools-usage'] },
  { id: 'nav.devtools.video-download', path: '/devtools/video-download', label: 'Video Downloader', section: 'Dev Tools', aliases: ['video-download', 'video-downloader', 'download-video'], keywords: ['youtube', 'x.com', 'twitter', 'yt-dlp', 'download', 'clip'] },
  { id: 'nav.workspace-contexts', path: '/workspace-contexts', label: 'Workspaces', section: 'Dev Tools', aliases: ['workspaces', 'workspace-contexts', 'project-contexts', 'project-switcher'], keywords: ['project', 'context', 'switch project', 'branch', 'shell', 'tasks', 'restore', 'working context'] },

  // Digital Twin's 19 sections render as five groups in-page — Profile,
  // Sources, Assessment, Presence, Legacy (see
  // client/src/components/digital-twin/constants.js SECTION_GROUPS, #3795).
  // Each section keeps its own entry so ⌘K and voice still address it directly;
  // the grouping shows up here as a `keywords` group tag on every section plus a
  // `twin-<group>` alias on one member of each group, so "twin sources" lands
  // somewhere sensible without adding a group-only path that no route serves.
  { id: 'nav.twin.overview', path: '/digital-twin/overview', label: 'Overview', section: 'Identity', aliases: ['twin-profile', 'digital-twin', 'twin'], keywords: ['profile'] },
  { id: 'nav.twin.accounts', path: '/digital-twin/accounts', label: 'Accounts', section: 'Identity', aliases: ['twin-accounts'], keywords: ['sources'] },
  { id: 'nav.twin.appearance', path: '/digital-twin/appearance', label: 'Appearance', section: 'Identity', aliases: ['twin-appearance', 'appearance', 'photo'], keywords: ['presence', 'image', 'photo', 'vision', 'face', 'identity', 'presentation', 'look', 'avatar'] },
  { id: 'nav.ask', path: '/ask', label: 'Ask Yourself', section: 'Identity', aliases: ['ask', 'ask-yourself', 'twin-chat'], keywords: ['chat', 'twin', 'conversation', 'advise', 'draft'] },
  { id: 'nav.twin.autobiography', path: '/digital-twin/autobiography', label: 'Autobiography', section: 'Identity', aliases: ['twin-autobiography', 'autobiography'], keywords: ['sources'] },
  { id: 'nav.twin.avatar-bio', path: '/digital-twin/avatar-bio', label: 'Avatar Bio', section: 'Identity', aliases: ['avatar-bio', 'twin-avatar-bio', 'avatar', 'live-avatar'], keywords: ['presence', 'heygen', 'tavus', 'simli', 'elevenlabs', 'persona', 'bio', 'voice', 'live avatar', 'who i am', 'how i speak', 'what i know'] },
  { id: 'nav.character', path: '/character', label: 'Character', section: 'Identity', aliases: ['character'] },
  { id: 'nav.twin.documents', path: '/digital-twin/documents', label: 'Documents', section: 'Identity', aliases: ['twin-sources', 'twin-documents'], keywords: ['sources'] },
  { id: 'nav.twin.enrich', path: '/digital-twin/enrich', label: 'Enrich', section: 'Identity', aliases: ['twin-enrich'], keywords: ['sources'] },
  { id: 'nav.twin.export', path: '/digital-twin/export', label: 'Export', section: 'Identity', aliases: ['twin-export'], keywords: ['legacy'] },
  { id: 'nav.twin.legacy', path: '/digital-twin/legacy', label: 'Legacy Bundle', section: 'Identity', aliases: ['twin-legacy', 'legacy-export', 'legacy-bundle', 'legacy'], keywords: ['legacy', 'bundle', 'backup', 'portable', 'pdf', 'archive', 'time capsule', 'export'] },
  { id: 'nav.goals', path: '/goals/list', label: 'Goals', section: 'Goals', aliases: ['goals'] },
  { id: 'nav.goals.tree', path: '/goals/tree', label: 'Goals Tree', section: 'Goals', aliases: ['goals-tree', 'goal-tree'], keywords: ['hierarchy', 'decomposition', 'subgoals', 'breakdown'] },
  { id: 'nav.twin.goals', path: '/digital-twin/goals', label: 'Twin Goals', section: 'Identity', aliases: ['twin-goals'], keywords: ['profile'] },
  { id: 'nav.twin.identity', path: '/digital-twin/identity', label: 'Identity', section: 'Identity', aliases: ['twin-identity', 'identity'], keywords: ['profile'] },
  { id: 'nav.twin.import', path: '/digital-twin/import', label: 'Import', section: 'Identity', aliases: ['twin-import'], keywords: ['sources'] },
  { id: 'nav.insights', path: '/insights/overview', label: 'Insights', section: 'Identity', aliases: ['insights'] },
  { id: 'nav.insights.genome-health', path: '/insights/genome-health', label: 'Genome-Health', section: 'Identity', aliases: ['genome-health', 'insights-genome-health'], keywords: ['genome', 'dna', 'health', 'longevity', 'genetic'] },
  { id: 'nav.insights.taste-identity', path: '/insights/taste-identity', label: 'Taste & Identity', section: 'Identity', aliases: ['taste-identity', 'insights-taste-identity'], keywords: ['taste', 'identity', 'preferences', 'aesthetic'] },
  { id: 'nav.insights.cross-domain', path: '/insights/cross-domain', label: 'Cross-Domain Patterns', section: 'Identity', aliases: ['cross-domain', 'insights-cross-domain', 'cross-domain-patterns'], keywords: ['cross domain', 'patterns', 'correlations', 'connections'] },
  { id: 'nav.insights.goal-scorecard', path: '/insights/goal-scorecard', label: 'Goal Scorecard', section: 'Identity', aliases: ['goal-scorecard', 'insights-goal-scorecard', 'scorecard'], keywords: ['goal', 'scorecard', 'time allocation', 'effectiveness', 'goal alignment', 'time vs goals'] },
  { id: 'nav.twin.interview', path: '/digital-twin/interview', label: 'Interview', section: 'Identity', aliases: ['twin-interview'], keywords: ['sources'] },
  { id: 'nav.twin.personality', path: '/digital-twin/personality', label: 'Personality', section: 'Identity', aliases: ['twin-personality', 'personality', 'model-personality'], keywords: ['assessment', 'llm', 'model', 'traits', 'radar', 'alignment', 'self-profile', 'compare', 'sycophancy'] },
  { id: 'nav.twin.personas', path: '/digital-twin/personas', label: 'Personas', section: 'Identity', aliases: ['twin-personas', 'personas', 'persona'], keywords: ['profile', 'context', 'professional', 'casual', 'voice', 'mode'] },
  { id: 'nav.twin.taste', path: '/digital-twin/taste', label: 'Taste', section: 'Identity', aliases: ['twin-taste'], keywords: ['profile'] },
  { id: 'nav.twin.test', path: '/digital-twin/test', label: 'Test', section: 'Identity', aliases: ['twin-assessment', 'twin-test'], keywords: ['assessment'] },
  { id: 'nav.twin.time-capsule', path: '/digital-twin/time-capsule', label: 'Time Capsule', section: 'Identity', aliases: ['time-capsule', 'twin-time-capsule', 'capsule'], keywords: ['legacy', 'archive', 'snapshot'] },
  { id: 'nav.twin.voice', path: '/digital-twin/voice', label: 'Voice', section: 'Identity', aliases: ['twin-presence', 'twin-voice', 'voice-style', 'spoken-written'], keywords: ['presence', 'speech', 'spoken', 'written', 'transcript', 'style', 'comparison', 'communication'] },
  { id: 'nav.identity.privacy-overview', path: '/privacy/overview', label: 'Privacy', section: 'Identity', aliases: ['privacy', 'privacy-center', 'my-data'], keywords: ['pii', 'privacy', 'personal data', 'identity facts', 'who has my data'] },
  { id: 'nav.identity.privacy-vault', path: '/privacy/vault', label: 'Vault', section: 'Identity', aliases: ['vault', 'pii-vault', 'privacy-vault'], keywords: ['pii', 'vault', 'encrypted', 'ssn', 'address', 'passport', 'identity'] },
  { id: 'nav.identity.privacy-organizations', path: '/privacy/organizations', label: 'Organizations', section: 'Identity', aliases: ['organizations', 'orgs', 'trusted-orgs'], keywords: ['organizations', 'banks', 'utilities', 'who holds my data', 'registry', 'holdings'] },
  { id: 'nav.identity.privacy-changes', path: '/privacy/changes', label: 'Changes', section: 'Identity', aliases: ['changes', 'change-of-address', 'address-change', 'privacy-changes'], keywords: ['change of address', 'moved', 'update address', 'inventory', 'who needs updating', 'new phone', 'new email'] },
  { id: 'nav.identity.privacy-brokers', path: '/privacy/brokers', label: 'Brokers', section: 'Identity', aliases: ['brokers', 'data brokers', 'opt out', 'remove my data', 'privacy-brokers'], keywords: ['data brokers', 'opt out', 'remove my data', 'people search', 'exposure', 'spokeo', 'whitepages', 'ccpa', 'delete my data'] },

  { id: 'nav.meatspace.overview', path: '/meatspace/overview', label: 'Overview', section: 'Health', aliases: ['meatspace'] },
  { id: 'nav.meatspace.health', path: '/meatspace/health', label: 'Body Health', section: 'Health', aliases: ['meatspace-health', 'body-health'], keywords: ['health', 'vitals', 'wellbeing', 'biometrics'] },
  { id: 'nav.meatspace.body', path: '/meatspace/body', label: 'Body', section: 'Health', aliases: ['meatspace-body', 'body'] },
  { id: 'nav.meatspace.alcohol', path: '/meatspace/alcohol', label: 'Alcohol', section: 'Health', aliases: ['meatspace-alcohol', 'alcohol'] },
  { id: 'nav.meatspace.nicotine', path: '/meatspace/nicotine', label: 'Nicotine', section: 'Health', aliases: ['meatspace-nicotine', 'nicotine'] },
  { id: 'nav.meatspace.age', path: '/meatspace/age', label: 'Age', section: 'Health', aliases: ['meatspace-age'] },
  { id: 'nav.meatspace.blood', path: '/meatspace/blood', label: 'Blood', section: 'Health', aliases: ['meatspace-blood', 'blood'] },
  { id: 'nav.meatspace.export', path: '/meatspace/export', label: 'Export', section: 'Health', aliases: ['meatspace-export', 'clinician-export', 'health-export'], keywords: ['clinician', 'doctor', 'print', 'pdf', 'summary', 'report', 'blood', 'lifestyle'] },
  { id: 'nav.meatspace.genome', path: '/meatspace/genome', label: 'Genome', section: 'Health', aliases: ['meatspace-genome', 'genome'] },
  { id: 'nav.meatspace.lifestyle', path: '/meatspace/lifestyle', label: 'Lifestyle', section: 'Health', aliases: ['meatspace-lifestyle', 'lifestyle'] },
  { id: 'nav.meatspace.settings', path: '/meatspace/settings', label: 'Settings', section: 'Health', aliases: ['meatspace-settings'] },

  { id: 'nav.post.launcher', path: '/post/launcher', label: 'Launcher', section: 'POST', aliases: ['post', 'post-launcher'] },
  { id: 'nav.post.config', path: '/post/config', label: 'Config', section: 'POST', aliases: ['post-config'] },
  { id: 'nav.post.explore', path: '/post/explore', label: 'Explore', section: 'POST', aliases: ['post-explore', 'practice-library', 'practice library', 'explore-post', 'all-drills', 'all drills', 'browse-practice'], keywords: ['catalog', 'library', 'browse', 'directory', 'what can i practice', 'test types', 'every drill', 'find a drill'] },
  { id: 'nav.post.history', path: '/post/history', label: 'History', section: 'POST', aliases: ['post-history'] },
  { id: 'nav.post.memory', path: '/post/memory', label: 'Memory', section: 'POST', aliases: ['post-memory'] },
  { id: 'nav.post.memory.elements', path: '/post/memory/elements', label: 'Elements', section: 'POST', aliases: ['post-elements', 'elements', 'periodic-table', 'elements-song'], keywords: ['periodic table', 'chemistry', 'symbols', 'flash cards', 'tom lehrer', 'atomic number'] },
  // Elements practice modes are individually navigable, the way each Morse mode
  // is — so ⌘K and voice can start a drill instead of only opening the page
  // (issue #3249). Per-item memory routes (`/post/memory/:itemId`) stay dynamic
  // and unregistered, like other `:id` detail routes.
  { id: 'nav.post.memory.elements.study', path: '/post/memory/elements/element-study', label: 'Elements Flash Cards', section: 'POST', aliases: ['elements-study', 'element-study', 'elements flash cards', 'flash-cards'], keywords: ['study', 'flip', 'reveal', 'symbols', 'pairings', 'periodic table'] },
  { id: 'nav.post.memory.elements.flash', path: '/post/memory/elements/element-flash', label: 'Element Flash', section: 'POST', aliases: ['element-flash', 'elements-flash', 'element flash'], keywords: ['recall', 'quiz', 'test', 'symbols', 'name the element', 'periodic table'] },
  { id: 'nav.post.memory.elements.lyrics', path: '/post/memory/elements/fill-blank', label: 'Elements Fill the Lyrics', section: 'POST', aliases: ['elements-fill-blank', 'fill-the-lyrics', 'elements lyrics'], keywords: ['lyrics', 'fill in the blank', 'recall', 'tom lehrer', 'song'] },
  { id: 'nav.post.memory.elements.learn', path: '/post/memory/elements/learn', label: 'Elements Learn Lyrics', section: 'POST', aliases: ['elements-learn', 'learn-lyrics', 'elements learn'], keywords: ['read', 'verses', 'study', 'lyrics', 'tom lehrer', 'song'] },
  { id: 'nav.post.morse', path: '/post/morse', label: 'Morse', section: 'POST', aliases: ['post-morse', 'morse', 'morse-code'], keywords: ['cw', 'ham', 'radio', 'koch', 'cognitive'] },
  { id: 'nav.post.plan', path: '/post/plan', label: 'Practice Plan', section: 'POST', aliases: ['post-plan', 'practice-plan', 'practice plan', 'plan'], keywords: ['topics', 'enable', 'disable', 'opt out', 'what am i studying', 'study plan', 'subjects'] },
  { id: 'nav.post.morse.copy', path: '/post/morse/copy', label: 'Morse Copy', section: 'POST', aliases: ['morse-copy', 'morse copy', 'copy-morse', 'morse-listen'], keywords: ['cw', 'koch', 'listen', 'decode', 'receive', 'ear'] },
  { id: 'nav.post.morse.head-copy', path: '/post/morse/head-copy', label: 'Morse Head Copy', section: 'POST', aliases: ['morse-head-copy', 'morse head copy', 'head-copy', 'head copy'], keywords: ['cw', 'koch', 'audio only', 'no reference', 'memory', 'recall'] },
  { id: 'nav.post.morse.send', path: '/post/morse/send', label: 'Morse Send', section: 'POST', aliases: ['morse-send', 'morse send', 'send-morse', 'morse-key', 'keying'], keywords: ['cw', 'key', 'straight key', 'transmit', 'dit', 'dah', 'spacebar'] },
  { id: 'nav.post.morse.tree', path: '/post/morse?ref=tree', label: 'Morse Tree', section: 'POST', aliases: ['morse-tree', 'morse tree', 'morse-chart', 'dichotomic'], keywords: ['cw', 'binary tree', 'chart', 'reference', 'dit dah'] },
  { id: 'nav.post.morse.length', path: '/post/morse?ref=length', label: 'Morse Length', section: 'POST', aliases: ['morse-length', 'morse length', 'morse-by-length'], keywords: ['cw', 'reference', 'symbol length', 'chart'] },
  { id: 'nav.post.morse.list', path: '/post/morse?ref=list', label: 'Morse List', section: 'POST', aliases: ['morse-list', 'morse list', 'morse-table', 'morse-alphabet'], keywords: ['cw', 'reference', 'alphabet', 'table', 'chart'] },
  { id: 'nav.post.progress', path: '/post/progress', label: 'Progress', section: 'POST', aliases: ['post-progress', 'progress'], keywords: ['trends', 'stats', 'streak', 'dashboard', 'time in training', 'accuracy', 'speed'] },
  { id: 'nav.post.progress.sessions', path: '/post/progress/sessions', label: 'Progress Sessions', section: 'POST', aliases: ['post-progress-sessions', 'progress-sessions', 'progress sessions', 'session-log'], keywords: ['session list', 'log', 'past runs', 'per-session', 'scores'] },
  { id: 'nav.post.rhetoric', path: '/post/rhetoric', label: 'Rhetoric', section: 'POST', aliases: ['post-rhetoric', 'rhetoric', 'rhetorical practice'], keywords: ['writing', 'brainstorming', 'iambic pentameter', 'diacope', 'chiasmus', 'progressia', 'figures of speech'] },
  { id: 'nav.post.rhetoric.meter', path: '/post/rhetoric/meter', label: 'Rhetoric Iambic Pentameter', section: 'POST', aliases: ['rhetoric-meter', 'iambic-pentameter', 'iambic pentameter', 'meter'], keywords: ['ten syllables', 'da-dum', 'verse', 'poetry', 'line'] },
  { id: 'nav.post.rhetoric.diacope', path: '/post/rhetoric/diacope', label: 'Rhetoric Diacope', section: 'POST', aliases: ['rhetoric-diacope', 'diacope'], keywords: ['repetition', 'emphasis', 'figure of speech'] },
  { id: 'nav.post.rhetoric.chiasmus', path: '/post/rhetoric/chiasmus', label: 'Rhetoric Chiasmus', section: 'POST', aliases: ['rhetoric-chiasmus', 'chiasmus'], keywords: ['reversal', 'mirror', 'crossed', 'figure of speech'] },
  { id: 'nav.post.rhetoric.progressia', path: '/post/rhetoric/progressia', label: 'Rhetoric Progressia', section: 'POST', aliases: ['rhetoric-progressia', 'progressia'], keywords: ['escalation', 'build', 'climax', 'figure of speech'] },
  { id: 'nav.post.rhetoric.brainstorm', path: '/post/rhetoric/brainstorm', label: 'Rhetorical Brainstorm', section: 'POST', aliases: ['rhetoric-brainstorm', 'rhetorical brainstorm', 'brainstorm'], keywords: ['angles', 'ideation', 'openings', 'metaphors'] },
  { id: 'nav.post.wordplay', path: '/post/wordplay', label: 'Wordplay', section: 'POST', aliases: ['post-wordplay'] },
  { id: 'nav.post.wordplay.compound-chain', path: '/post/wordplay/compound-chain', label: 'Compound Chain', section: 'POST', aliases: ['wordplay-compound-chain', 'compound-chain', 'compound chain'], keywords: ['compound words', 'seed word', 'chain'] },
  { id: 'nav.post.wordplay.bridge-word', path: '/post/wordplay/bridge-word', label: 'Bridge Word', section: 'POST', aliases: ['wordplay-bridge-word', 'bridge-word', 'bridge word'], keywords: ['linking word', 'connector', 'puzzle'] },
  { id: 'nav.post.wordplay.double-meaning', path: '/post/wordplay/double-meaning', label: 'Double Meaning', section: 'POST', aliases: ['wordplay-double-meaning', 'double-meaning', 'double meaning'], keywords: ['homonym', 'two meanings', 'pun'] },
  { id: 'nav.post.wordplay.idiom-twist', path: '/post/wordplay/idiom-twist', label: 'Idiom Twist', section: 'POST', aliases: ['wordplay-idiom-twist', 'idiom-twist', 'idiom twist'], keywords: ['idiom', 'phrase', 'twist', 'domain swap'] },

  { id: 'nav.settings.ai-assignments', path: '/settings/ai-assignments', label: 'AI Assignments', section: 'Settings', aliases: ['ai-assignments', 'assignments', 'settings-ai-assignments', 'ai-inventory'], keywords: ['provider', 'model', 'pin', 'inventory', 'migration', 'llm'] },
  { id: 'nav.settings.api-access', path: '/settings/api-access', label: 'API Access', section: 'Settings', aliases: ['api-access', 'settings-api-access', 'public-api', 'swagger', 'openapi'], keywords: ['rest', 'external', 'tts api', 'sdapi', 'voice api', 'docs', 'curl', 'expose', 'passwordless', 'auth gating'] },
  { id: 'nav.devtools.api-explorer', path: '/api-reference/catalog', label: 'API Explorer', section: 'Dev Tools', aliases: ['api-explorer', 'api-reference', 'swagger-ui', 'rest-reference'], keywords: ['openapi', 'rest', 'endpoints', 'routes', 'agent tools', 'contracts', 'developer docs'] },
  { id: 'nav.settings.autofixer', path: '/settings/autofixer', label: 'Autofixer', section: 'Settings', aliases: ['autofixer', 'settings-autofixer', 'auto-fixer'], keywords: ['crash', 'fix', 'pm2', 'repair', 'ai provider', 'restart'] },
  { id: 'nav.settings.backup', path: '/settings/backup', label: 'Backup', section: 'Settings', aliases: ['backup', 'settings-backup'] },
  { id: 'nav.settings.credentials', path: '/settings/credentials', label: 'Credentials', section: 'Settings', aliases: ['settings-credentials', 'credentials', 'api-keys', 'tokens'], keywords: ['configured', 'unconfigured', 'env', 'huggingface', 'civitai', 'jira', 'datadog', 'telegram'] },
  { id: 'nav.settings.database', path: '/settings/database', label: 'Database', section: 'Settings', aliases: ['settings-database', 'database'] },
  { id: 'nav.settings.features', path: '/settings/features', label: 'Features', section: 'Settings', aliases: ['settings-features', 'instance-features', 'feature-usage'], keywords: ['enabled', 'disabled', 'instance', 'optional', 'participation', 'metrics', 'reminders'] },
  { id: 'nav.settings.general', path: '/settings/general', label: 'General', section: 'Settings', aliases: ['settings', 'settings-general', 'general'] },
  // Local-model management is its own top-level section (#4736), which grew to
  // cover every KIND of model this install manages (#4728) — image/video
  // checkpoints, LoRAs and their training datasets, embeddings, and the
  // image-to-3D runtimes. Several ids keep a `nav.settings.*` / `nav.media.*`
  // prefix: they are opaque and stored in palette history, so renaming them
  // would orphan those entries — only the path, label and section move.
  { id: 'nav.models.3d', path: '/models/3d', label: '3D', section: 'Models', aliases: ['3d-runtimes', 'image-to-3d-runtimes', 'trellis-install', 'pixal3d-install'], keywords: ['trellis', 'pixal3d', 'install', 'repair', 'runtime', 'mesh', 'image to 3d', 'on-device'] },
  { id: 'nav.models.code-reviewers', path: '/models/code-reviewers', label: 'Code Reviewers', section: 'Models', previousPaths: ['/settings/code-reviewers'], aliases: ['code-reviewers', 'settings-code-reviewers', 'code-review', 'review-defaults', 'reviewers'], keywords: ['review loop', 'reviewer chain', 'codex', 'copilot', 'ollama', 'stop mode', 'max rounds', 'defaults'] },
  { id: 'nav.settings.embeddings', path: '/models/embeddings', label: 'Embeddings', section: 'Models', previousPaths: ['/settings/embeddings'], aliases: ['settings-embeddings', 'embeddings', 'embedding'], keywords: ['vector', 'pgvector', 'semantic search', 'nomic', 'ollama', 'lm studio'] },
  { id: 'nav.settings.local-llm', path: '/models/llms', label: 'LLMs', section: 'Models', previousPaths: ['/settings/local-llm'], aliases: ['local-llm', 'local-llms', 'llms', 'models-llms', 'ollama', 'lm-studio', 'lmstudio'], keywords: ['ollama', 'lm studio', 'local model', 'local llm', 'gguf', 'pull model', 'install model', 'migrate', 'switch backend', 'llama.cpp'] },
  { id: 'nav.models.llms.abuse', path: '/models/llms/abuse', label: 'Abuse Guard', section: 'Models', aliases: ['abuse-guard', 'model-abuse', 'model-abuse-guard', 'prompt-guard', 'prompt guard'], keywords: ['classifier', 'prompt injection', 'security scan', 'llama prompt guard', 'install guard'] },
  { id: 'nav.media.loras', path: '/models/loras', label: 'LoRAs', section: 'Models', previousPaths: ['/media/loras'], aliases: ['loras', 'lora', 'lora-manager', 'civitai'], keywords: ['lora', 'civitai', 'fine-tune', 'style adapter', 'realstagram', 'photoreal', 'flux lora'] },
  { id: 'nav.media.training', path: '/models/training', label: 'Training', section: 'Models', previousPaths: ['/media/training', '/media/training/:datasetId'], aliases: ['training', 'lora-training', 'train-lora', 'datasets', 'character-lora'], keywords: ['fine-tune', 'dataset', 'caption', 'dreambooth', 'character consistency', 'train', 'flux lora'] },
  { id: 'nav.media.models', path: '/models/media', label: 'Media', section: 'Models', previousPaths: ['/media/models', '/media-models'], aliases: ['media-models', 'image-models', 'video-models', 'huggingface'], keywords: ['hf cache', 'model storage', 'disk', 'add model', 'install model', 'custom model'] },
  { id: 'nav.models.performance', path: '/models/performance', label: 'Performance', section: 'Models', aliases: ['model-performance', 'performance', 'assessments', 'model-assessments', 'benchmark-models', 'tuning'], keywords: ['measure', 'assessment', 'benchmark', 'throughput', 'chars per second', 'ttft', 'context', 'tuning', 'llama.cpp', 'mtplx', 'vllm', 'which model', 'fastest model'] },
  // Absorbed the Dev Tools 'Model Resources' page (#4728), so its aliases and
  // keywords live here — 'model resources' and 'downloaded models' must keep
  // resolving after the fold.
  { id: 'nav.models.status', path: '/models/status', label: 'Status', section: 'Models', previousPaths: ['/system-resources/models'], aliases: ['model-status', 'models-status', 'memory-management', 'resident-models', 'model-resources', 'loaded-models', 'downloaded-models', 'model-memory'], keywords: ['memory', 'resident', 'loaded', 'unload', 'ram', 'vram', 'free memory', 'what is loaded', 'ollama', 'lm studio', 'hugging face', 'lora', 'delete model', 'disk'] },
  { id: 'nav.settings.local-llm-playground', path: '/local-llm/playground', label: 'Playground', section: 'Models', aliases: ['llm-playground', 'playground', 'model-playground', 'compare-models'], keywords: ['ollama', 'lm studio', 'compare', 'benchmark', 'chat', 'test model', 'ttft', 'tokens per second', 'local llm'] },
  { id: 'nav.settings.mortalloom', path: '/settings/mortalloom', label: 'MortalLoom', section: 'Settings', feature: 'health', aliases: ['settings-mortalloom', 'mortalloom'] },
  { id: 'nav.settings.openclaw', path: '/openclaw', label: 'OpenClaw', section: 'Settings', feature: 'openclaw', aliases: ['openclaw', 'settings-openclaw'], keywords: ['operator', 'chat', 'agent', 'runtime', 'sessions', 'streaming'] },
  { id: 'nav.settings.security', path: '/settings/security', label: 'Security', section: 'Settings', aliases: ['settings-security', 'login-password', 'auth-password', 'password-settings'], keywords: ['password', 'login', 'auth', 'sign-in', 'lock', 'tailnet', 'sidecar'] },
  { id: 'nav.capabilities', path: '/capabilities', label: 'Setup', section: 'Settings', aliases: ['setup', 'onboarding', 'walkthrough', 'capabilities', 'capability-map', 'integrations'], keywords: ['first run', 'status', 'setup', 'checklist', 'tailscale', 'https', 'dns', 'providers', 'connected systems', 'integrations', 'health overview'] },
  { id: 'nav.settings.sharing', path: '/settings/sharing', label: 'Sharing', section: 'Settings', aliases: ['settings-sharing', 'sharing-settings'], keywords: ['display name', 'bio', 'attribution', 'identity', 'source'] },
  { id: 'nav.settings.telegram', path: '/settings/telegram', label: 'Telegram', section: 'Settings', aliases: ['settings-telegram', 'telegram'] },
  { id: 'nav.settings.voice', path: '/settings/voice', label: 'Voice', section: 'Settings', aliases: ['settings-voice', 'voice', 'voice-settings'], keywords: ['mic', 'microphone', 'speech', 'tts', 'whisper', 'kokoro'] },
  { id: 'nav.settings.facetime', path: '/settings/voice', label: 'FaceTime Audio', section: 'Settings', feature: 'facetime', aliases: ['facetime', 'facetime-audio', 'call-settings'], keywords: ['facetime', 'audio call', 'call', 'hang up', 'blackhole'] },
  { id: 'nav.settings.call-host', path: '/voice/call-host', label: 'Call Host', section: 'Settings', feature: 'facetime', aliases: ['call-host', 'voice-call-host', 'facetime-call-host', 'audio-bridge', 'meeting-capture', 'capture-audio'], keywords: ['facetime', 'call audio', 'blackhole', 'bridge', 'attach', 'microphone', 'speaker', 'call host', 'meeting capture', 'transcribe meeting', 'record meeting'] },

  { id: 'nav.ambient', path: '/ambient', label: 'Ambient', section: 'Dev Tools', aliases: ['ambient', 'ambient-mode', 'ambient mode'], keywords: ['idle', 'background', 'display', 'screensaver', 'fullscreen'] },
  { id: 'nav.data', path: '/data', label: 'Data', section: 'Dev Tools', aliases: ['data'] },
  { id: 'nav.instances', path: '/instances', label: 'Instances', section: 'Dev Tools', aliases: ['instances'] },
  { id: 'nav.loops', path: '/loops', label: 'Loops', section: 'Dev Tools', aliases: ['loops'] },
  { id: 'nav.devtools.processes', path: '/devtools/processes', label: 'Processes', section: 'Dev Tools', aliases: ['devtools-processes', 'processes'] },
  { id: 'nav.security', path: '/security', label: 'Security', section: 'Dev Tools', aliases: ['security'] },
  { id: 'nav.system-resources', path: '/system-resources', label: 'System Resources', section: 'Dev Tools' },
  { id: 'nav.system-health', path: '/system-resources/overview', label: 'System Resources Overview', section: 'Dev Tools', previousPaths: ['/system-health'], aliases: ['system-resources', 'system-health', 'system-status', 'memory-usage', 'cpu-usage'], keywords: ['health', 'memory', 'cpu', 'disk', 'thresholds', 'top processes', 'resource usage', 'build', 'commit', 'running build', 'stale build', 'which code is running'] },
  { id: 'nav.system-resources.storage', path: '/system-resources/storage', label: 'Storage Report', section: 'Dev Tools', aliases: ['disk-usage', 'storage-report', 'disk-cleanup'], keywords: ['disk', 'storage', 'space', 'cleanup', 'cache', 'data usage', 'ai triage'] },
  { id: 'nav.system-resources.queues', path: '/system-resources/queues', label: 'Active Queues', section: 'Dev Tools', aliases: ['active-queues', 'job-queues', 'pending-jobs', 'render-queue'], keywords: ['media jobs', 'agent tasks', 'pending', 'running', 'cancel', 'run now'] },
  { id: 'nav.cos.jobs', path: '/cos/jobs', label: 'System Tasks', section: 'Chief of Staff', aliases: ['cos-jobs', 'system-tasks'] },
  { id: 'nav.uploads', path: '/uploads', label: 'Uploads', section: 'Dev Tools', aliases: ['uploads'] },

  { id: 'nav.wiki.overview', path: '/wiki/overview', label: 'Wiki', section: 'Brain', aliases: ['wiki'] },
  { id: 'nav.wiki.browse', path: '/wiki/browse', label: 'Browse', section: 'Brain', aliases: ['wiki-browse'] },
  { id: 'nav.wiki.graph', path: '/wiki/graph', label: 'Graph', section: 'Brain', aliases: ['wiki-graph'] },
  { id: 'nav.wiki.log', path: '/wiki/log', label: 'Log', section: 'Brain', aliases: ['wiki-log'] },
  { id: 'nav.wiki.search', path: '/wiki/search', label: 'Search', section: 'Brain', aliases: ['wiki-search'] },
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

// Every feature id this manifest gates on, for the registry-drift guard.
export const NAV_FEATURE_IDS = [...new Set(NAV_COMMANDS.map((c) => c.feature).filter(Boolean))].sort();

const seenIds = new Set();
for (const cmd of NAV_COMMANDS) {
  if (!cmd.id || !cmd.path || !cmd.label || !cmd.section) {
    throw new Error(`navManifest: malformed entry ${JSON.stringify(cmd)}`);
  }
  if (!cmd.path.startsWith('/')) {
    throw new Error(`navManifest: path must start with / — got "${cmd.path}" for ${cmd.id}`);
  }
  if (seenIds.has(cmd.id)) throw new Error(`navManifest: duplicate id ${cmd.id}`);
  seenIds.add(cmd.id);
}

// Alias collisions resolve to the first-declared entry; ordering is load-bearing.
const aliasToPath = {};
for (const cmd of NAV_COMMANDS) {
  for (const alias of (cmd.aliases || [])) {
    if (!aliasToPath[alias]) aliasToPath[alias] = cmd.path;
  }
}
const ALIAS_KEYS = Object.keys(aliasToPath);

export const getNavAliasMap = () => ({ ...aliasToPath });

export const normalizeLabel = (s) => (s || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?:;,"']+$/, '');

export const resolveNavCommand = (input) => {
  if (!input || typeof input !== 'string') return null;
  const norm = normalizeLabel(input).replace(/\s+/g, '-');
  if (!norm) return null;

  const tail = norm.split('-').filter(Boolean).pop();
  // Each tier is { test, longest? }. `longest:true` picks the longest matching
  // alias (so "meatspace health" prefers `meatspace-health` over the shorter
  // `health` that also ends/contains-matches the input). Other tiers keep
  // first-declared-wins ordering because shorter aliases there are intentional
  // (e.g. `cos` should match before `cos-tasks` when input is bare "cos").
  const tiers = [
    { test: (a) => a === norm },
    { test: (a) => norm.startsWith(a) && a.length >= 3 },
    { test: (a) => a.startsWith(norm) },
    { test: (a) => norm.endsWith(`-${a}`) && a.length >= 3, longest: true },
    { test: (a) => norm.includes(a) && a.length >= 4, longest: true },
    { test: (a) => a.includes(norm) },
    { test: (a) => tail && tail !== norm && a === tail },
  ];

  let matched = null;
  for (const { test, longest } of tiers) {
    if (longest) {
      const candidates = ALIAS_KEYS.filter(test);
      if (candidates.length) {
        matched = candidates.reduce((a, b) => (b.length > a.length ? b : a));
        break;
      }
    } else {
      matched = ALIAS_KEYS.find(test);
      if (matched) break;
    }
  }
  if (!matched) return null;

  const path = aliasToPath[matched];
  const command = NAV_COMMANDS.find((c) => c.path === path && (c.aliases || []).includes(matched))
    || NAV_COMMANDS.find((c) => c.path === path);
  return { path, matched, command };
};
