// Navigation search metadata (aliases and keywords) and fuzzy command resolver for Cmd+K and voice nav.
//
// Extracted from `server/lib/navManifest.js` so the client cold-load shell does not bundle ~38 KB of
// search aliases and keywords until lazy `CmdKSearch` loads; server-side voice tools, palette, and
// agent context import this module directly. `navManifest.test.js` enforces 1:1 ID parity.

import { NAV_COMMANDS, normalizeLabel } from './navManifest.js';

export const NAV_SEARCH_METADATA = Object.freeze({
  'nav.dashboard': { aliases: ['dashboard', 'home'], keywords: ['overview', 'start'] },
  'nav.review-hub': { aliases: ['review', 'review-hub'] },
  'nav.eidoverse.guest': { aliases: ['eidoverse-guest'], keywords: ['travel', 'teleport', 'visitor'] },
  'nav.eidoverse.solo': { aliases: ['eidoverse-solo', 'world-only', 'eidoverse-alone'], keywords: ['fullscreen', 'solo', 'without controls', 'chromeless'] },
  'nav.eidoverse': { aliases: ['eidoverse', 'eidoverse-worlds', 'worlds', 'openworld', 'open-world', 'city'], keywords: ['3d', 'world', 'agents', 'spatial', 'managed app', 'private environment'] },
  'nav.apps': { aliases: ['apps'] },
  'nav.apps.create': { aliases: ['create-app', 'new-app'] },
  'nav.apps.submodules': { aliases: ['submodules', 'devtools-submodules', 'portos-submodules'], keywords: ['git', 'slashdo', 'vendored', 'update submodule'] },
  'nav.templates': { aliases: ['templates', 'app-templates'], keywords: ['app template', 'create app', 'pre-configured', 'starter'] },
  'nav.catalog': { aliases: ['catalog', 'ingredients', 'creative-catalog'], keywords: ['character', 'place', 'object', 'idea', 'scene', 'concept', 'inventory', 'reference', 'creative'] },
  'nav.catalog.ingest': { aliases: ['catalog-ingest', 'ingest', 'paste-scrap', 'extract-ingredients'], keywords: ['paste', 'snippet', 'scene', 'idea', 'extract', 'scrap', 'import-catalog'] },
  'nav.catalog.settings': { aliases: ['catalog settings', 'catalog-settings', 'settings-catalog', 'catalog-types'], keywords: ['catalog', 'types', 'labels', 'character', 'place', 'object', 'taxonomy'] },
  'nav.create.casting': { aliases: ['casting', 'cast', 'characters', 'actors', 'casting-sheets', 'cast-list'], keywords: ['character', 'casting sheet', 'turnaround', 'wardrobe', 'looks', 'performer', 'actor', 'reference'] },
  'nav.create.casting-import': { aliases: ['import-cast', 'cast-import', 'import-sets', 'backfill-cast'], keywords: ['music video', 'casting sheet', 'set plate', 'catalog', 'backfill', 'import'] },
  'nav.create.environments': { aliases: ['environments', 'environment', 'sets', 'locations', 'places', 'set-list'], keywords: ['place', 'set', 'location', 'clean plate', 'background', 'scene setting', 'reference'] },
  'nav.create.objects': { aliases: ['objects', 'props', 'prop-list', 'items'], keywords: ['object', 'prop', 'artifact', 'talisman', 'macguffin', 'reference'] },
  'nav.media': { aliases: ['media', 'media-gen', 'mediagen', 'generate', 'media-studio'], keywords: ['image', 'video', 'render', 'art', 'movie'] },
  'nav.media.image': { aliases: ['image-gen', 'imagegen', 'generate-image', 'sd', 'stable-diffusion'], keywords: ['stable diffusion', 'render', 'art', 'picture', 'photo', 'draw', 'flux', 'mflux'] },
  'nav.media.video': { aliases: ['video-gen', 'videogen', 'generate-video', 'ltx'], keywords: ['video', 'animate', 'movie', 'clip', 'ltx', 'episode composer', 'continuous video', 'multi-scene'] },
  'nav.media.prompt': { aliases: ['prompt-from-media', 'analyze-media-prompt'], keywords: ['vision', 'reverse prompt', 'describe media', 'image prompt', 'video prompt'] },
  'nav.media.pages': { aliases: ['html-pages', 'html-bench', 'page-bench', 'web-design-bench', 'compare-html'], keywords: ['html', 'web design', 'frontend', 'creative', 'model comparison', 'side by side', 'iframe', 'gallery', 'local model'] },
  'nav.media.pages.runs': { aliases: ['html-pages-runs', 'html-bench-runs'], keywords: ['runs', 'retry', 'compare', 'model comparison', 'html'] },
  'nav.media.pages.gallery': { aliases: ['html-pages-gallery', 'html-gallery'], keywords: ['gallery', 'pages', 'prompt', 'plan', 'copy prompt', 'html'] },
  'nav.media.annotate': { aliases: ['annotate', 'media-annotate', 'sketch', 'draw-over', 'markup'], keywords: ['annotation', 'sketch', 'draw', 'markup', 'scribble', 'label', 'canvas', 'overlay', 'stroke'] },
  'nav.media.timeline': { aliases: ['timeline', 'video-timeline', 'editor'], keywords: ['edit', 'trim', 'composite', 'stitch', 'cut', 'compose'] },
  'nav.media.history': { aliases: ['media-history', 'video-history'], keywords: ['videos', 'gallery', 'stitch'] },
  'nav.media.collections': { aliases: ['collections', 'media-collections', 'stacks', 'projects'], keywords: ['bucket', 'group', 'project', 'album', 'organize'] },
  'nav.create.code-animation': { aliases: ['code-animation', 'codeanimation', 'code-video', 'procedural-animation', 'animation-prompt'], keywords: ['animation', 'canvas', 'webgl', 'procedural', 'no assets', 'llm prompt', 'motion graphics', 'universe style', 'mood board', 'audio reactive', 'record video', 'html animation'] },
  'nav.create.code-animation.gallery': { aliases: ['code-animation-gallery', 'animation-gallery', 'past-animations'], keywords: ['gallery', 'thumbnails', 'posters', 'past animations', 'history', 'reopen animation', 'saved animations'] },
  'nav.create.code-animation.production': { aliases: ['code-animation-production', 'animation-production', 'production-animation', 'blender-film-projects'], keywords: ['film projects', 'accepted output', 'compare runs', 'evidence', 'source packages', 'immutable revisions', 'animation history'] },
  'nav.create.creative-director': { aliases: ['creative-director', 'video', 'browse-video', 'creative', 'director', 'producer', 'orchestrator', 'long-form', 'episode', 'video-production', 'create-video', 'video-workspace'], keywords: ['story', 'episode', 'narrative', 'agent', 'auto-video', 'long-form', 'directive', 'production plan', 'plan board', 'orchestrator', 'studio', 'producer'] },
  'nav.create.creative-commission': { aliases: ['creative-commission', 'commissions', 'commission', 'creation-engine', 'autonomous-creation', 'standing-brief', 'recurring-brief'], keywords: ['schedule', 'recurring', 'nightly', 'brief', 'autonomous', 'creation engine', 'cron', 'feedback', 'taste', 'standing commission', 'auto-generate'] },
  'nav.create.creative-commission.new': { aliases: ['new-creative-commission', 'create-creative-commission'] },
  'nav.create.fableloom': { aliases: ['fableloom', 'fable-loom', 'loom', 'branching-narrative', 'interactive-story', 'branching-story'], keywords: ['branching', 'interactive', 'narrative', 'intent', 'endings', 'reader', 'scene', 'node', 'graph', 'nonlinear', 'play', 'story graph'] },
  'nav.create.game': { aliases: ['game', 'games', 'game-studio'], keywords: ['managed app', 'sprite', 'atlas', 'music', 'asset bundle', 'manifest', 'feedback'] },
  'nav.create.music-video': { aliases: ['music-video', 'musicvideo', 'music video', 'mv', 'sync-to-beat'], keywords: ['music', 'beat', 'sync', 'audio-reactive', 'director', 'scene board', 'tempo', 'choreography', 'autonomous', 'suno', 'one prompt', 'lyrics'] },
  'nav.create.music-video.new': { aliases: ['new-music-video', 'create-music-video', 'new music video', 'create music video'], keywords: ['music video', 'new', 'create', 'project', 'draft'] },
  'nav.create.music-video.setup': { aliases: ['music-video-setup', 'mv-setup', 'music video setup', 'music-video-song', 'mv-song'], keywords: ['music video', 'song', 'setup', 'track', 'audio', 'lyrics'] },
  'nav.create.music-video.cast-sets': { aliases: ['cast-and-sets', 'cast-sets', 'cast and sets', 'music-video-cast-sets', 'music-video-look', 'mv-look'], keywords: ['music video', 'look', 'cast', 'sets', 'characters', 'visual spec', 'art direction'] },
  'nav.create.music-video.board': { aliases: ['music-video-plan', 'mv-plan', 'mv-storyboard', 'board', 'open-the-board', 'open the board', 'music-video-board', 'music-video-storyboard'], keywords: ['music video', 'plan', 'storyboard', 'timeline', 'treatment', 'beat timeline'] },
  'nav.create.music-video.previz': { aliases: ['music-video-previz', 'mv-previz', 'previz', 'previs', 'greybox-previz', 'music video previz'], keywords: ['music video', 'previz', 'greybox', 'blocking', 'camera', 'three.js', '3d', 'animatic'] },
  'nav.create.music-video.produce': { aliases: ['music-video-shots', 'mv-shots', 'scene-board', 'produce', 'music-video-produce', 'mv-produce', 'music-video-make', 'mv-make', 'compose', 'music-video-compose', 'mv-compose'], keywords: ['music video', 'shots', 'scenes', 'stills', 'clips', 'locks', 'make', 'footage', 'typography', 'takes', 'production'] },
  'nav.create.music-video.review': { aliases: ['music-video-review', 'mv-review', 'music video review', 'music-video-render', 'mv-render'], keywords: ['music video', 'final render', 'render', 'review', 'export', 'drafts'] },
  'nav.create.music-video.publish': { aliases: ['music-video-publish', 'mv-publish', 'music video publish'], keywords: ['music video', 'publish', 'release', 'kit', 'social'] },
  'nav.create.music-video.editor': { aliases: ['music-video-editor', 'mv-editor', 'music video editor', 'video-editor', 'shot-timeline', 'shot timeline'], keywords: ['music video', 'editor', 'timeline', 'shots', 'cut', 'trim', 'reorder', 'playhead', 'nle', 'edit'] },
  'nav.create.music-video.assets': { aliases: ['music-video-assets', 'mv-assets', 'music video assets', 'asset-manager', 'asset manager'], keywords: ['music video', 'assets', 'stills', 'clips', 'takes', 'ingredients', 'bad', 'cleanup', 'media'] },
  'nav.create.music-video-cleanup': { aliases: ['music-video-cleanup', 'mv-cleanup', 'music video cleanup'], keywords: ['superseded', 'renders', 'film looks', 'disk', 'cleanup'] },
  'nav.create.decks': { aliases: ['decks', 'deck', 'card-deck', 'playing-cards', 'tarot', 'tarot-deck', 'cards'], keywords: ['playing cards', 'tarot', 'card deck', 'card design', 'suits', 'arcana', 'style guide', 'batch render', 'card art'] },
  'nav.create.mood-boards': { aliases: ['mood-boards', 'mood-board', 'moodboard', 'mood', 'inspiration', 'references'], keywords: ['inspiration', 'reference', 'pin', 'visual', 'canvas', 'collect', 'pinboard', 'palette', 'ideas'] },
  'nav.create.storyboards': { aliases: ['storyboards', 'storyboard', 'story-board', 'shot-planner', 'beat-board'], keywords: ['story beats', 'panels', 'shots', 'animatic', 'plan', 'film', 'music video', 'sketch', 'shot list', 'previs'] },
  'nav.media.sprites': { aliases: ['sprites', 'sprite', 'sprite-manager', 'sprite-sheets'], keywords: ['sprite sheet', 'atlas', 'game art', 'pixel art', 'character animation', 'walk cycle', 'anchors'] },
  'nav.create.3d': { aliases: ['3d', 'image-to-mesh', 'mesh', 'trellis', 'pixal3d', 'neural-3d', 'blender-models', 'blender-model'], keywords: ['blender model', 'blender python', 'parts', 'game asset', 'trellis', 'pixal3d', 'pixal', 'glb', 'mesh', 'photogrammetry', 'neural', 'image to 3d', 'render', 'generate', 'pbr'] },
  'nav.media.threejs': { aliases: ['threejs', 'three-js', '3d-models', 'image-to-3d', 'img2threejs'], keywords: ['procedural', '3d', 'mesh', 'model', 'gallery', 'webgl', 'preview'] },
  'nav.create.authors': { aliases: ['authors', 'author', 'byline', 'author-persona', 'writer-persona'], keywords: ['author', 'byline', 'pen name', 'persona', 'writing style', 'bio', 'headshot', 'cover', 'book author'] },
  'nav.create.voice-studio': { aliases: ['voice-studio', 'character-voices', 'voice-lab'], keywords: ['auk', 'speech', 'timbre', 'pitch', 'design', 'characters', 'tts'] },
  'nav.create.universe-builder': { aliases: ['universes', 'universe', 'universe-builder', 'worldbuilder', 'worldbuild', 'world', 'lore', 'universe-canon', 'canon'], keywords: ['style template', 'sci-fi', 'fantasy', 'concept art', 'batch render', 'variations', 'characters', 'settings', 'objects', 'canon entries', 'list', 'manage'] },
  'nav.create.universe-builder.new': { aliases: ['new-universe', 'create-universe'] },
  'nav.create.importer': { aliases: ['importer', 'import'], keywords: ['paste', 'screenplay', 'novel', 'short story', 'comic script', 'analyze', 'reverse-engineer', 'extract'] },
  'nav.create.pipeline': { aliases: ['series', 'pipeline', 'production', 'series-pipeline', 'production-pipeline'], keywords: ['series', 'issue', 'episode', 'comic', 'script', 'prose', 'storyboard', 'narrative', 'workflow'] },
  'nav.create.pipeline.editorial-checks': { aliases: ['editorial-checks', 'editorial', 'checks', 'editorial-review', 'content-checks', 'manuscript-checks'], keywords: ['editorial', 'check', 'review', 'naming', 'exposition', 'info-dumping', 'continuity', 'quality', 'lint', 'triage', 'findings', 'deterministic', 'llm'] },
  'nav.create.pipeline-continuity-bible': { aliases: ['continuity-bible', 'continuity', 'series-continuity', 'facts-ledger', 'established-facts', 'canon-ledger'], keywords: ['continuity', 'bible', 'facts', 'ledger', 'established', 'knowledge-leak', 'contradiction', 'timeline', 'wardrobe', 'prop', 'physical-traits', 'who-knows-what'] },
  'nav.create.pipeline-voice-fingerprint': { aliases: ['voice-fingerprint', 'voice-drift', 'fingerprint', 'voice-matrix', 'prose-fingerprint'], keywords: ['voice', 'drift', 'fingerprint', 'matrix', 'style', 'prose', 'sentence-rhythm', 'outlier', 'metrics', 'deterministic', 'editorial', 'consistency', 'register', 'vocabulary-wells'] },
  'nav.create.pipeline-export': { aliases: ['export', 'prose-export', 'series-export', 'manuscript-export', 'epub', 'ebook', 'publish'], keywords: ['export', 'manuscript', 'epub', 'ebook', 'pdf', 'print', 'interior', 'trade paperback', 'compiled', 'download', 'publish', 'trim size', 'title page', 'book'] },
  'nav.create.sharing': { aliases: ['sharing', 'share', 'buckets', 'share-buckets'], keywords: ['google drive', 'dropbox', 'icloud', 'syncthing', 'export', 'import', 'collaborate', 'federation', 'peer', 'cross-network'] },
  'nav.create.sharing-duplicates': { aliases: ['duplicates', 'duplicate-universes', 'duplicate-series', 'dedupe', 'merge-duplicates'], keywords: ['duplicate', 'merge', 'rename', 'same name', 'two copies', 'reconcile', 'collision'] },
  'nav.create.sharing-conflicts': { aliases: ['conflicts', 'sync-conflicts', 'edit-conflicts', 'conflict-journal'], keywords: ['conflict', 'overwrite', 'lost edit', 'restore', 'merge fields', 'last write wins', 'diverged', 'recover'] },
  'nav.create.start-story': { aliases: ['start-story', 'start-a-story', 'start', 'begin-story', 'create-story', 'onramp'], keywords: ['start here', 'begin', 'idea', 'import', 'prose', 'story builder', 'writers room', 'importer', 'how to start', 'new', 'front door', 'choose'] },
  'nav.create.story-builder': { aliases: ['story-builder', 'storybuilder', 'guided', 'new-story', 'story-wizard'], keywords: ['idea', 'universe', 'arc', 'reader map', 'guided', 'wizard', 'linear', 'lock', 'front door', 'episode', 'series'] },
  'nav.create.rounds': { aliases: ['rounds', 'round', 'songs', 'song', 'a-cappella', 'acappella', 'sing'], keywords: ['round', 'song', 'lyrics', 'melody', 'harmony', 'dirge', 'ballad', 'a cappella', 'vocal', 'choir', 'singing', 'arrangement', 'quodlibet', '500 miles'] },
  'nav.create.rounds-guide': { aliases: ['rounds-guide', 'round-guide', 'songs-guide', 'song-guide', 'singing-guide', 'round-learning'], keywords: ['rhythm shapes', 'dirge', 'voice layers', 'harmony', 'notation', 'lead sheet', 'solfege', 'learn round', 'learn song', 'a cappella', 'singing help'] },
  'nav.create.music': { aliases: ['music', 'music-studio', 'generate-music'], keywords: ['music generation', 'ace-step', 'acestep', 'musicgen', 'audioldm', 'album', 'track', 'single', 'album art', 'artist', 'song generation', 'audio', 'beat', 'producer'] },
  'nav.create.music-generate': { aliases: ['music-generate', 'music-designer', 'design-music', 'write-a-song', 'make-music'], keywords: ['generate music', 'music designer', 'describe music', 'enrich prompt', 'write lyrics', 'lyrics', 'ace-step', 'reference track', 'vibe', 'step by step', 'wizard', 'draw waveform', 'drawn waveform', 'wavetable', 'strudel', 'live code', 'music code'] },
  'nav.create.music-artists': { aliases: ['music-artists', 'artists', 'artist', 'artist-persona', 'musician', 'band'], keywords: ['artist persona', 'musician', 'band', 'byline', 'portrait', 'genre', 'musical style', 'stage name'] },
  'nav.create.music-albums': { aliases: ['albums', 'album', 'music-albums', 'discography', 'lp', 'ep'], keywords: ['album', 'cover art', 'tracklist', 'release', 'discography', 'record'] },
  'nav.create.music-tracks': { aliases: ['tracks', 'track', 'music-tracks', 'singles', 'songs-audio'], keywords: ['track', 'single', 'audio', 'recording', 'lyrics', 'mp3', 'wav', 'generate track'] },
  'nav.media.settings': { aliases: ['media-settings', 'image-gen-settings', 'sd-settings', 'video-gen-settings'] },
  'nav.writers-room': { aliases: ['writers-room', 'writersroom', 'writer', 'write', 'studio', 'novel', 'story-studio'], keywords: ['prose', 'screenplay', 'story', 'draft', 'manuscript', 'literary', 'novel', 'short story'] },
  'nav.writers-room.guide': { aliases: ['writers-room-guide', 'writing-guide', 'writing-rules', 'word-count', 'length-targets'], keywords: ['microfiction', 'flash fiction', 'short story', 'novelette', 'novella', 'novel length', 'word count', 'character count', 'book length', 'craft', 'writing advice', 'emotional roadmap', 'documentation', 'help'] },
  'nav.settings.prompts': { aliases: ['prompts', 'prompt-stages'], keywords: ['stage', 'template', 'prompt manager'] },
  'nav.settings.prompts.variables': { aliases: ['prompt-variables'], keywords: ['variable', 'snippet', 'prompt manager'] },
  'nav.settings.prompts.agent-skills': { aliases: ['agent-skills', 'skill-curator', 'procedural-skills'], keywords: ['skill', 'curator', 'pin', 'lock', 'archive', 'rollback', 'agentskills', 'prompt manager'] },
  'nav.settings.prompts.job-skills': { aliases: ['job-skills', 'prompt-job-skills'], keywords: ['job skill', 'autonomous job', 'skill template', 'prompt manager'] },
  'nav.settings.providers': { aliases: ['providers', 'ai-providers', 'presets', 'ai-presets', 'provider-presets'], keywords: ['preset', 'harness', 'service', 'model', 'effort', 'compose', 'compatibility matrix', 'default provider'] },
  'nav.settings.providers.new': { aliases: ['new-provider-preset', 'create-provider-preset'] },
  'nav.ai.harnesses': { aliases: ['harnesses', 'harness', 'ai-harnesses', 'agent-harnesses', 'coding-clis', 'cli-harnesses', 'provider-harnesses', 'harness-enablement', 'credential-bootstraps', 'bootstraps'], keywords: ['enable harness', 'disable harness', 'claude code', 'codex', 'opencode', 'pi', 'direct api', 'cli', 'tui', 'bootstrap', 'launch wrapper', 'sign in', 'quota', 'antigravity', 'agy', 'grok', 'kimi', 'hermes', 'cursor', 'install cli', 'update cli', 'upgrade', 'version', 'refresh models'] },
  'nav.ai.services': { aliases: ['ai-services', 'services', 'provider-services', 'backends', 'connections', 'backend-connections', 'provider-connections', 'harness-connections'], keywords: ['endpoint', 'api key', 'plan', 'free', 'paid', 'subscription', 'model catalog', 'refresh catalog', 'ollama', 'nvidia', 'openrouter', 'add service'] },
  'nav.ai.services.new': { aliases: ['new-ai-service', 'add-ai-service'] },
  'nav.settings.fleet-llm': { aliases: ['fleet-llm', 'gpu-host', 'remote-ai-provider'], keywords: ['3090', 'tailscale', 'vllm', 'qwen', 'coding model', 'dedicated host'] },
  'nav.brain.inbox': { aliases: ['brain', 'brain-inbox', 'inbox'] },
  'nav.brain.threads': { aliases: ['threads', 'brain-threads', 'bullet-journal', 'open-loops'], keywords: ['todo', 'tracking', 'next action', 'open loops', 'bullet journal'] },
  'nav.brain.ideas': { aliases: ['brain-ideas', 'ideas'], keywords: ['brainstorm', 'creative', 'thought', 'concept'] },
  'nav.brain.daily-log': { aliases: ['daily-log', 'journal'] },
  'nav.brain.links': { aliases: ['brain-links'] },
  'nav.brain.meditation': { aliases: ['meditation', 'brain-meditation', '40-hz'], keywords: ['sound', 'audio', 'forty hertz'] },
  'nav.brain.memory': { aliases: ['brain-memory', 'memory'] },
  'nav.brain.notes': { aliases: ['brain-notes', 'notes'] },
  'nav.brain.graph': { aliases: ['brain-graph'] },
  'nav.brain.digest': { aliases: ['brain-digest'] },
  'nav.brain.feeds': { aliases: ['brain-feeds', 'feeds', 'rss'], keywords: ['rss', 'subscriptions'] },
  'nav.brain.trust': { aliases: ['brain-trust'] },
  'nav.brain.import': { aliases: ['brain-import', 'import-chatgpt', 'chatgpt-import'], keywords: ['chatgpt', 'openai', 'export', 'third-party'] },
  'nav.settings.spotify': { aliases: ['settings-spotify', 'spotify', 'spotify-settings', 'brain-spotify'], keywords: ['spotify', 'music', 'listening', 'recently played', 'oauth', 'timeline', 'taste', 'media'] },
  'nav.settings.youtube': { aliases: ['settings-youtube', 'youtube', 'youtube-settings', 'brain-youtube'], keywords: ['youtube', 'watch history', 'video', 'scrape', 'takeout', 'timeline', 'taste', 'media'] },
  'nav.brain.config': { aliases: ['brain-config'] },
  'nav.brain.idealoom': { aliases: ['idealoom', 'idea-loom', 'idealoom-lists'], keywords: ['obsidian', 'vault', 'ordered list', 'local lists'] },
  'nav.rapid-reader': { aliases: ['rapid-reader', 'speed-reader', 'rsvp', 'spritz'], keywords: ['speed reading', 'rapid reading', 'rsvp', 'spritz', 'word per minute', 'wpm', 'focal'] },
  'nav.brain.songbook': { aliases: ['songbook', 'song-book', 'tabs', 'chords', 'guitar-tabs'], keywords: ['guitar', 'tab', 'tablature', 'chord chart', 'lyrics', 'sheet music', 'repertoire', 'autoscroll'] },
  'nav.brain.songbook.import': { aliases: ['import-songbook', 'songbook-import'] },
  'nav.calendar.agenda': { aliases: ['calendar', 'agenda'] },
  'nav.calendar.day': { aliases: ['calendar-day'] },
  'nav.calendar.week': { aliases: ['calendar-week'] },
  'nav.calendar.month': { aliases: ['calendar-month'] },
  'nav.calendar.lifetime': { aliases: ['calendar-lifetime'] },
  'nav.calendar.review': { aliases: ['calendar-review'] },
  'nav.calendar.sync': { aliases: ['calendar-sync'] },
  'nav.calendar.config': { aliases: ['calendar-config'] },
  'nav.cos.briefing': { aliases: ['briefing', 'cos-briefing'] },
  'nav.cos.tasks': { aliases: ['tasks', 'cos', 'cos-tasks', 'chief-of-staff'] },
  'nav.cos.agents': { aliases: ['agents', 'cos-agents'] },
  'nav.cos.jobs': { aliases: ['cos-jobs', 'system-tasks'] },
  'nav.cos.runs': { aliases: ['runs', 'ai-runs', 'cos-runs', 'recent-runs', 'run-history'], keywords: ['runs', 'run history', 'recent runs', 'ai runs', 'agent runs', 'failed runs'] },
  'nav.cos.run-events': { aliases: ['run-events', 'cos-run-events', 'run-event-ledger', 'lifecycle-events'], keywords: ['run events', 'lifecycle', 'ledger', 'replay', 'diagnostics', 'orphaned', 'handoff', 'reconnect', 'interrupted', 'why did this run fail'] },
  'nav.cos.schedule': { aliases: ['schedule', 'cos-schedule'] },
  'nav.cos.workflow': { aliases: ['workflow', 'cos-workflow', 'cos-timeline', 'schedule-timeline'], keywords: ['timeline', 'schedule', 'launch order', 'run order', 'gantt', 'upcoming runs', 'overlap', 'dependencies'] },
  'nav.cos.digest': { aliases: ['cos-digest'] },
  'nav.cos.gsd': { aliases: ['gsd', 'cos-gsd'] },
  'nav.cos.learning': { aliases: ['cos-learning'] },
  'nav.cos.memory': { aliases: ['cos-memory'] },
  'nav.cos.mind': { aliases: ['cos-mind', 'persistent-mind', 'mind-chat'], keywords: ['persistent mind', 'chat', 'annotation', 'resident mind', 'conversation'] },
  'nav.cos.health': { aliases: ['cos-health', 'health'] },
  'nav.cos.config': { aliases: ['cos-config'] },
  'nav.feature-agents': { aliases: ['feature-agents'] },
  'nav.feature-agents.create': { aliases: ['create-feature-agent', 'new-feature-agent'] },
  'nav.cos.mind-tools': { aliases: ['mind-tools', 'persistent-mind-tools', 'tools-access'], keywords: ['persistent mind', 'tools', 'access', 'permissions', 'authority', 'capabilities'] },
  'nav.social-agents': { aliases: ['social-agents'] },
  'nav.messages.inbox': { aliases: ['messages', 'comms', 'comms-inbox'], keywords: ['comms', 'email', 'inbox'] },
  'nav.messages.drafts': { aliases: ['drafts', 'comms-drafts'], keywords: ['comms'] },
  'nav.messages.imessage': { aliases: ['imessage', 'i-message', 'apple-messages', 'comms-imessage'], keywords: ['comms', 'imessage', 'sms', 'text messages', 'chat.db', 'blocklist', 'spam'] },
  'nav.messages.signal': { aliases: ['signal', 'signal-desktop', 'comms-signal', 'signal-settings'], keywords: ['comms', 'signal', 'signal desktop', 'messages', 'sqlcipher', 'chat', 'tribe', 'timeline', 'encrypted', 'keychain'] },
  'nav.messages.beeper': { aliases: ['beeper', 'beeper-chat', 'comms-beeper'], keywords: ['comms', 'beeper', 'bridge', 'whatsapp', 'discord', 'telegram', 'instagram', 'slack', 'chat', 'unified inbox'] },
  'nav.messages.beeper-settings': { aliases: ['beeper-settings', 'settings-beeper', 'beeper-sync'], keywords: ['beeper', 'settings', 'token', 'sync', 'bridge', 'status', 'connection', 'interval'] },
  'nav.messages.contacts': { aliases: ['contacts', 'address-book', 'comms-contacts', 'settings-contacts'], keywords: ['comms', 'contacts', 'address book', 'phone', 'email', 'tribe', 'imessage', 'names', 'resolve'] },
  'nav.messages.imessage-settings': { aliases: ['settings-imessage', 'imessage-settings', 'imessage-sync'], keywords: ['imessage', 'sync', 'chat.db', 'sms', 'texts', 'tribe', 'timeline', 'full disk access'] },
  'nav.messages.sync': { aliases: ['messages-sync', 'comms-sync'], keywords: ['comms'] },
  'nav.messages.config': { aliases: ['messages-config', 'comms-config'], keywords: ['comms'] },
  'nav.stacker-news': { aliases: ['stacker-news', 'stacker', 'sn'], keywords: ['comms', 'community', 'territory', 'moderation', 'stewardship'] },
  'nav.x': { aliases: ['x', 'x-com', 'twitter', 'comms-x'], keywords: ['comms', 'social', 'reach', 'engagement', 'shadowban', 'diagnostics'] },
  'nav.timeline': { aliases: ['activity-timeline', 'activity', 'my-day', 'life-log', 'life-timeline'], keywords: ['human activity', 'life log', 'timeline', 'messages', 'calendar', 'history', 'what did i do', 'daily', 'import', 'backfill', 'whatsapp', 'spotify', 'discord', 'youtube'] },
  'nav.tribe': { aliases: ['tribe', 'relationships', 'relationship-manager', 'people'], keywords: ['dunbar', 'friends', 'family', 'network', 'social graph', 'care cadence'] },
  'nav.browser': { aliases: ['browser'] },
  'nav.devtools.runner': { aliases: ['devtools-runner'] },
  'nav.devtools.datadog': { aliases: ['datadog', 'devtools-datadog'] },
  'nav.devtools.github': { aliases: ['github', 'devtools-github'] },
  'nav.devtools.github-accounts': { aliases: ['github-accounts', 'github-enterprise'], keywords: ['github', 'enterprise', 'ghes', 'gh auth', 'login', 'trust', 'notifications'] },
  'nav.devtools.github-inbox': { aliases: ['github-inbox', 'github-notifications'], keywords: ['github', 'notifications', 'inbox', 'mentions', 'review requests', 'mute', 'unsubscribe'] },
  'nav.devtools.github-audit': { aliases: ['github-audit', 'notification-audit'], keywords: ['github', 'notifications', 'unwatch', 'unsubscribe', 'subscriptions', 'noise'] },
  'nav.devtools.github-automations': { aliases: ['github-automations', 'github-triage'], keywords: ['github', 'notifications', 'schedule', 'triage', 'observe', 'run now'] },
  'nav.devtools.github-repos': { aliases: ['github-repos', 'github-secrets'], keywords: ['github', 'repositories', 'secrets', 'archive', 'npm'] },
  'nav.devtools.history': { aliases: ['devtools-history'] },
  'nav.devtools.image-clean': { aliases: ['image-clean', 'image-cleaner'], keywords: ['metadata', 'c2pa', 'content-credentials', 'sharp', 'denoise'] },
  'nav.devtools.jira': { aliases: ['jira', 'devtools-jira'] },
  'nav.devtools.jira-reports': { aliases: ['jira-reports'] },
  'nav.devtools.quota-burn': { aliases: ['quota-burn', 'burn-quota', 'quota'], keywords: ['subscription', 'usage', 'reset window', 'spend quota', 'claude', 'codex', 'grok', 'agy', 'burn'] },
  'nav.shell': { aliases: ['shell', 'terminal'] },
  'nav.shell-iterm': { aliases: ['iterm', 'iterm2'], keywords: ['terminal', 'mac', 'sessions'] },
  'nav.devtools.usage': { aliases: ['devtools-usage'] },
  'nav.devtools.video-download': { aliases: ['video-download', 'video-downloader', 'download-video'], keywords: ['youtube', 'x.com', 'twitter', 'yt-dlp', 'download', 'clip'] },
  'nav.workspace-contexts': { aliases: ['workspaces', 'workspace-contexts', 'project-contexts', 'project-switcher'], keywords: ['project', 'context', 'switch project', 'branch', 'shell', 'tasks', 'restore', 'working context'] },
  'nav.twin.overview': { aliases: ['twin-profile', 'digital-twin', 'twin'], keywords: ['profile'] },
  'nav.twin.identity': { aliases: ['twin-identity', 'identity'], keywords: ['profile'] },
  'nav.twin.personas': { aliases: ['twin-personas', 'personas', 'persona'], keywords: ['profile', 'context', 'professional', 'casual', 'voice', 'mode'] },
  'nav.twin.goals': { aliases: ['twin-goals'], keywords: ['profile'] },
  'nav.twin.taste': { aliases: ['twin-taste'], keywords: ['profile'] },
  'nav.twin.documents': { aliases: ['twin-sources', 'twin-documents'], keywords: ['sources'] },
  'nav.twin.import': { aliases: ['twin-import'], keywords: ['sources'] },
  'nav.twin.accounts': { aliases: ['twin-accounts'], keywords: ['sources'] },
  'nav.twin.interview': { aliases: ['twin-interview'], keywords: ['sources'] },
  'nav.twin.autobiography': { aliases: ['twin-autobiography', 'autobiography'], keywords: ['sources'] },
  'nav.twin.enrich': { aliases: ['twin-enrich'], keywords: ['sources'] },
  'nav.twin.test': { aliases: ['twin-assessment', 'twin-test'], keywords: ['assessment'] },
  'nav.twin.personality': { aliases: ['twin-personality', 'personality', 'model-personality'], keywords: ['assessment', 'llm', 'model', 'traits', 'radar', 'alignment', 'self-profile', 'compare', 'sycophancy'] },
  'nav.twin.voice': { aliases: ['twin-presence', 'twin-voice', 'voice-style', 'spoken-written'], keywords: ['presence', 'speech', 'spoken', 'written', 'transcript', 'style', 'comparison', 'communication'] },
  'nav.twin.appearance': { aliases: ['twin-appearance', 'appearance', 'photo'], keywords: ['presence', 'image', 'photo', 'vision', 'face', 'identity', 'presentation', 'look', 'avatar'] },
  'nav.twin.avatar-bio': { aliases: ['avatar-bio', 'twin-avatar-bio', 'avatar', 'live-avatar'], keywords: ['presence', 'heygen', 'tavus', 'simli', 'elevenlabs', 'persona', 'bio', 'voice', 'live avatar', 'who i am', 'how i speak', 'what i know'] },
  'nav.twin.export': { aliases: ['twin-export'], keywords: ['legacy'] },
  'nav.twin.legacy': { aliases: ['twin-legacy', 'legacy-export', 'legacy-bundle', 'legacy'], keywords: ['legacy', 'bundle', 'backup', 'portable', 'pdf', 'archive', 'time capsule', 'export'] },
  'nav.twin.time-capsule': { aliases: ['time-capsule', 'twin-time-capsule', 'capsule'], keywords: ['legacy', 'archive', 'snapshot'] },
  'nav.ask': { aliases: ['ask', 'ask-yourself', 'twin-chat'], keywords: ['chat', 'twin', 'conversation', 'advise', 'draft'] },
  'nav.character': { aliases: ['character'] },
  'nav.goals': { aliases: ['goals'] },
  'nav.goals.tree': { aliases: ['goals-tree', 'goal-tree'], keywords: ['hierarchy', 'decomposition', 'subgoals', 'breakdown'] },
  'nav.insights': { aliases: ['insights'] },
  'nav.insights.genome-health': { aliases: ['genome-health', 'insights-genome-health'], keywords: ['genome', 'dna', 'health', 'longevity', 'genetic'] },
  'nav.insights.taste-identity': { aliases: ['taste-identity', 'insights-taste-identity'], keywords: ['taste', 'identity', 'preferences', 'aesthetic'] },
  'nav.insights.cross-domain': { aliases: ['cross-domain', 'insights-cross-domain', 'cross-domain-patterns'], keywords: ['cross domain', 'patterns', 'correlations', 'connections'] },
  'nav.insights.goal-scorecard': { aliases: ['goal-scorecard', 'insights-goal-scorecard', 'scorecard'], keywords: ['goal', 'scorecard', 'time allocation', 'effectiveness', 'goal alignment', 'time vs goals'] },
  'nav.identity.privacy-overview': { aliases: ['privacy', 'privacy-center', 'my-data'], keywords: ['pii', 'privacy', 'personal data', 'identity facts', 'who has my data'] },
  'nav.identity.privacy-vault': { aliases: ['vault', 'pii-vault', 'privacy-vault'], keywords: ['pii', 'vault', 'encrypted', 'ssn', 'address', 'passport', 'identity'] },
  'nav.identity.privacy-organizations': { aliases: ['organizations', 'orgs', 'trusted-orgs'], keywords: ['organizations', 'banks', 'utilities', 'who holds my data', 'registry', 'holdings'] },
  'nav.identity.privacy-changes': { aliases: ['changes', 'change-of-address', 'address-change', 'privacy-changes'], keywords: ['change of address', 'moved', 'update address', 'inventory', 'who needs updating', 'new phone', 'new email'] },
  'nav.identity.privacy-brokers': { aliases: ['brokers', 'data brokers', 'opt out', 'remove my data', 'privacy-brokers'], keywords: ['data brokers', 'opt out', 'remove my data', 'people search', 'exposure', 'spokeo', 'whitepages', 'ccpa', 'delete my data'] },
  'nav.meatspace.overview': { aliases: ['meatspace'] },
  'nav.meatspace.age': { aliases: ['meatspace-age'] },
  'nav.meatspace.alcohol': { aliases: ['meatspace-alcohol', 'alcohol'] },
  'nav.meatspace.blood': { aliases: ['meatspace-blood', 'blood'] },
  'nav.meatspace.body': { aliases: ['meatspace-body', 'body'] },
  'nav.meatspace.export': { aliases: ['meatspace-export', 'clinician-export', 'health-export'], keywords: ['clinician', 'doctor', 'print', 'pdf', 'summary', 'report', 'blood', 'lifestyle'] },
  'nav.meatspace.genome': { aliases: ['meatspace-genome', 'genome'] },
  'nav.meatspace.health': { aliases: ['meatspace-health', 'body-health'], keywords: ['health', 'vitals', 'wellbeing', 'biometrics'] },
  'nav.meatspace.settings': { aliases: ['meatspace-settings'] },
  'nav.meatspace.lifestyle': { aliases: ['meatspace-lifestyle', 'lifestyle'] },
  'nav.meatspace.nicotine': { aliases: ['meatspace-nicotine', 'nicotine'] },
  'nav.post.launcher': { aliases: ['post', 'post-launcher'] },
  'nav.post.config': { aliases: ['post-config'] },
  'nav.post.explore': { aliases: ['post-explore', 'practice-library', 'practice library', 'explore-post', 'all-drills', 'all drills', 'browse-practice'], keywords: ['catalog', 'library', 'browse', 'directory', 'what can i practice', 'test types', 'every drill', 'find a drill'] },
  'nav.post.history': { aliases: ['post-history'] },
  'nav.post.memory': { aliases: ['post-memory'] },
  'nav.post.memory.elements': { aliases: ['post-elements', 'elements', 'periodic-table', 'elements-song'], keywords: ['periodic table', 'chemistry', 'symbols', 'flash cards', 'tom lehrer', 'atomic number'] },
  'nav.post.memory.elements.study': { aliases: ['elements-study', 'element-study', 'elements flash cards', 'flash-cards'], keywords: ['study', 'flip', 'reveal', 'symbols', 'pairings', 'periodic table'] },
  'nav.post.memory.elements.flash': { aliases: ['element-flash', 'elements-flash', 'element flash'], keywords: ['recall', 'quiz', 'test', 'symbols', 'name the element', 'periodic table'] },
  'nav.post.memory.elements.lyrics': { aliases: ['elements-fill-blank', 'fill-the-lyrics', 'elements lyrics'], keywords: ['lyrics', 'fill in the blank', 'recall', 'tom lehrer', 'song'] },
  'nav.post.memory.elements.learn': { aliases: ['elements-learn', 'learn-lyrics', 'elements learn'], keywords: ['read', 'verses', 'study', 'lyrics', 'tom lehrer', 'song'] },
  'nav.post.morse': { aliases: ['post-morse', 'morse', 'morse-code'], keywords: ['cw', 'ham', 'radio', 'koch', 'cognitive'] },
  'nav.post.plan': { aliases: ['post-plan', 'practice-plan', 'practice plan', 'plan'], keywords: ['topics', 'enable', 'disable', 'opt out', 'what am i studying', 'study plan', 'subjects'] },
  'nav.post.morse.copy': { aliases: ['morse-copy', 'morse copy', 'copy-morse', 'morse-listen'], keywords: ['cw', 'koch', 'listen', 'decode', 'receive', 'ear'] },
  'nav.post.morse.head-copy': { aliases: ['morse-head-copy', 'morse head copy', 'head-copy', 'head copy'], keywords: ['cw', 'koch', 'audio only', 'no reference', 'memory', 'recall'] },
  'nav.post.morse.send': { aliases: ['morse-send', 'morse send', 'send-morse', 'morse-key', 'keying'], keywords: ['cw', 'key', 'straight key', 'transmit', 'dit', 'dah', 'spacebar'] },
  'nav.post.morse.tree': { aliases: ['morse-tree', 'morse tree', 'morse-chart', 'dichotomic'], keywords: ['cw', 'binary tree', 'chart', 'reference', 'dit dah'] },
  'nav.post.morse.length': { aliases: ['morse-length', 'morse length', 'morse-by-length'], keywords: ['cw', 'reference', 'symbol length', 'chart'] },
  'nav.post.morse.list': { aliases: ['morse-list', 'morse list', 'morse-table', 'morse-alphabet'], keywords: ['cw', 'reference', 'alphabet', 'table', 'chart'] },
  'nav.post.progress': { aliases: ['post-progress', 'progress'], keywords: ['trends', 'stats', 'streak', 'dashboard', 'time in training', 'accuracy', 'speed'] },
  'nav.post.progress.sessions': { aliases: ['post-progress-sessions', 'progress-sessions', 'progress sessions', 'session-log'], keywords: ['session list', 'log', 'past runs', 'per-session', 'scores'] },
  'nav.post.rhetoric': { aliases: ['post-rhetoric', 'rhetoric', 'rhetorical practice'], keywords: ['writing', 'brainstorming', 'iambic pentameter', 'diacope', 'chiasmus', 'progressia', 'figures of speech'] },
  'nav.post.rhetoric.meter': { aliases: ['rhetoric-meter', 'iambic-pentameter', 'iambic pentameter', 'meter'], keywords: ['ten syllables', 'da-dum', 'verse', 'poetry', 'line'] },
  'nav.post.rhetoric.diacope': { aliases: ['rhetoric-diacope', 'diacope'], keywords: ['repetition', 'emphasis', 'figure of speech'] },
  'nav.post.rhetoric.chiasmus': { aliases: ['rhetoric-chiasmus', 'chiasmus'], keywords: ['reversal', 'mirror', 'crossed', 'figure of speech'] },
  'nav.post.rhetoric.progressia': { aliases: ['rhetoric-progressia', 'progressia'], keywords: ['escalation', 'build', 'climax', 'figure of speech'] },
  'nav.post.rhetoric.brainstorm': { aliases: ['rhetoric-brainstorm', 'rhetorical brainstorm', 'brainstorm'], keywords: ['angles', 'ideation', 'openings', 'metaphors'] },
  'nav.post.wordplay': { aliases: ['post-wordplay'] },
  'nav.post.wordplay.compound-chain': { aliases: ['wordplay-compound-chain', 'compound-chain', 'compound chain'], keywords: ['compound words', 'seed word', 'chain'] },
  'nav.post.wordplay.bridge-word': { aliases: ['wordplay-bridge-word', 'bridge-word', 'bridge word'], keywords: ['linking word', 'connector', 'puzzle'] },
  'nav.post.wordplay.double-meaning': { aliases: ['wordplay-double-meaning', 'double-meaning', 'double meaning'], keywords: ['homonym', 'two meanings', 'pun'] },
  'nav.post.wordplay.idiom-twist': { aliases: ['wordplay-idiom-twist', 'idiom-twist', 'idiom twist'], keywords: ['idiom', 'phrase', 'twist', 'domain swap'] },
  'nav.settings.ai-assignments': { aliases: ['ai-assignments', 'assignments', 'settings-ai-assignments', 'ai-inventory'], keywords: ['provider', 'model', 'pin', 'inventory', 'migration', 'llm'] },
  'nav.settings.api-access': { aliases: ['api-access', 'settings-api-access', 'public-api', 'swagger', 'openapi'], keywords: ['rest', 'external', 'tts api', 'sdapi', 'voice api', 'docs', 'curl', 'expose', 'passwordless', 'auth gating'] },
  'nav.devtools.api-explorer': { aliases: ['api-explorer', 'api-reference', 'swagger-ui', 'rest-reference'], keywords: ['openapi', 'rest', 'endpoints', 'routes', 'agent tools', 'contracts', 'developer docs'] },
  'nav.settings.autofixer': { aliases: ['autofixer', 'settings-autofixer', 'auto-fixer'], keywords: ['crash', 'fix', 'pm2', 'repair', 'ai provider', 'restart'] },
  'nav.settings.backup': { aliases: ['backup', 'settings-backup'] },
  'nav.settings.credentials': { aliases: ['settings-credentials', 'credentials', 'api-keys', 'tokens'], keywords: ['configured', 'unconfigured', 'env', 'huggingface', 'civitai', 'jira', 'datadog', 'telegram'] },
  'nav.settings.database': { aliases: ['settings-database', 'database'] },
  'nav.settings.features': { aliases: ['settings-features', 'instance-features', 'feature-usage'], keywords: ['enabled', 'disabled', 'instance', 'optional', 'participation', 'metrics', 'reminders'] },
  'nav.settings.general': { aliases: ['settings', 'settings-general', 'general'] },
  'nav.models.comparison': { aliases: ['model-comparison', 'model-cost', 'model-intelligence'], keywords: ['benchmark', 'effort', 'cost', 'quota', 'compare', 'intelligence'] },
  'nav.models.fallbacks': { aliases: ['fallbacks', 'provider-fallbacks', 'fallback-list', 'fallback-order'], keywords: ['failover', 'preset order', 'retry', 'next provider', 'usage limit', 'ordered list', 'wrap'] },
  'nav.models.3d': { aliases: ['3d-runtimes', 'image-to-3d-runtimes', 'trellis-install', 'pixal3d-install'], keywords: ['trellis', 'pixal3d', 'install', 'repair', 'runtime', 'mesh', 'image to 3d', 'on-device'] },
  'nav.models.decision-classifiers': { aliases: ['decision-classifiers', 'classifiers'], keywords: ['jev', 'laya', 'mlx', 'decision systems', 'experiments'] },
  'nav.models.laya-mlx': { aliases: ['laya', 'laya-mlx', 'layla'], keywords: ['classifier', 'apple silicon', 'typed decisions'] },
  'nav.models.code-reviewers': { aliases: ['code-reviewers', 'settings-code-reviewers', 'code-review', 'review-defaults', 'reviewers'], keywords: ['review loop', 'reviewer chain', 'codex', 'copilot', 'ollama', 'stop mode', 'max rounds', 'defaults'] },
  'nav.models.code-reviewers.follow-up': { aliases: ['reviewer-follow-up', 'goal-fidelity', 'code-review-follow-up'], keywords: ['objective', 'fidelity', 'rethink', 'file issue', 'finished run', 'follow-up'] },
  'nav.settings.embeddings': { aliases: ['settings-embeddings', 'embeddings', 'embedding'], keywords: ['vector', 'pgvector', 'semantic search', 'nomic', 'ollama', 'lm studio'] },
  'nav.settings.local-llm': { aliases: ['local-llm', 'local-llms', 'llms', 'models-llms', 'ollama', 'lm-studio', 'lmstudio'], keywords: ['ollama', 'lm studio', 'local model', 'local llm', 'gguf', 'pull model', 'install model', 'migrate', 'switch backend', 'llama.cpp'] },
  'nav.models.llms.abuse': { aliases: ['abuse-guard', 'model-abuse', 'model-abuse-guard', 'prompt-guard', 'prompt guard'], keywords: ['classifier', 'prompt injection', 'security scan', 'llama prompt guard', 'install guard'] },
  'nav.models.llms.jev': { aliases: ['jev', 'openjev', 'entailment', 'nli', 'decision-scorer'], keywords: ['entailment', 'nli', 'closed set', 'abstain', 'margin', 'scorer', 'decision', 'install jev'] },
  'nav.models.jev.try': { aliases: ['jev-try'], keywords: ['jev', 'try'] },
  'nav.models.jev.integrations': { aliases: ['jev-integrations'], keywords: ['jev', 'integrations'] },
  'nav.models.jev.results': { aliases: ['jev-results'], keywords: ['jev', 'results'] },
  'nav.models.jev.training': { aliases: ['jev-training'], keywords: ['jev', 'training'] },
  'nav.models.jev.setup': { aliases: ['jev-setup'], keywords: ['jev', 'setup'] },
  'nav.models.llms-runtimes': { aliases: ['runtimes', 'llm-runtimes', 'local-runtimes', 'model-runtimes', 'llama-server', 'llama-cpp', 'slotstream', 'mtplx'], keywords: ['llama.cpp', 'llama-server', 'mtplx', 'slotstream', 'start server', 'stop server', 'local server', 'model server', 'speculative decoding', 'draft model', 'checkpoint', 'idle release'] },
  'nav.media.loras': { aliases: ['loras', 'lora', 'lora-manager', 'civitai', 'data-maintenance', 'retired-data', 'lora-training', 'training', 'datasets', 'train-lora', 'character-lora'], keywords: ['cleanup', 'obsolete', 'storage', 'delete', 'retired training', 'lora', 'civitai', 'fine-tune', 'style adapter', 'realstagram', 'photoreal', 'flux lora'] },
  'nav.media.models': { aliases: ['media-models', 'image-models', 'video-models', 'huggingface'], keywords: ['hf cache', 'model storage', 'disk', 'add model', 'install model', 'custom model'] },
  'nav.models.performance': { aliases: ['model-performance', 'performance', 'assessments', 'model-assessments', 'benchmark-models', 'tuning'], keywords: ['measure', 'assessment', 'benchmark', 'throughput', 'chars per second', 'ttft', 'context', 'tuning', 'llama.cpp', 'mtplx', 'vllm', 'which model', 'fastest model'] },
  'nav.models.performance.results': { aliases: ['performance-results', 'assessment-results'], keywords: ['measured results', 'model evidence', 'selected evidence', 'rankings'] },
  'nav.models.performance.capabilities': { aliases: ['performance-capabilities', 'model-capability-tests'], keywords: ['capability tests', 'model abilities', 'saved capability results'] },
  'nav.models.performance.agent-checks': { aliases: ['performance-agent-checks', 'model-agent-checks'], keywords: ['opencode', 'tui', 'agent task', 'pty'] },
  'nav.models.performance.tuning': { aliases: ['performance-tuning', 'assessment-tuning'], keywords: ['tuning comparison', 'sweep', 'launch knobs', 'tokens per second'] },
  'nav.models.status': { aliases: ['model-status', 'models-status', 'memory-management', 'resident-models', 'model-resources', 'loaded-models', 'downloaded-models', 'model-memory'], keywords: ['memory', 'resident', 'loaded', 'unload', 'ram', 'vram', 'free memory', 'what is loaded', 'ollama', 'lm studio', 'hugging face', 'lora', 'delete model', 'disk'] },
  'nav.models.subscriptions': { aliases: ['subscriptions', 'subscription', 'plans', 'ai-subscriptions', 'my-plans', 'model-subscriptions', 'billing', 'ai-billing'], keywords: ['plan', 'price', 'spend', 'cost', 'billing', 'enable', 'disable', 'claude max', 'chatgpt plus', 'pro', 'tier', 'savings', 'quota', 'usage', 'quotas'] },
  'nav.settings.local-llm-playground': { aliases: ['llm-playground', 'playground', 'model-playground', 'compare-models'], keywords: ['ollama', 'lm studio', 'compare', 'benchmark', 'chat', 'test model', 'ttft', 'tokens per second', 'local llm'] },
  'nav.settings.mortalloom': { aliases: ['settings-mortalloom', 'mortalloom'] },
  'nav.settings.openclaw': { aliases: ['openclaw', 'settings-openclaw'], keywords: ['operator', 'chat', 'agent', 'runtime', 'sessions', 'streaming'] },
  'nav.settings.orchestration': { aliases: ['orchestration', 'orchestration-profiles', 'cos-orchestration', 'agent-roles'], keywords: ['orchestration', 'roles', 'architect', 'implementer', 'reviewer', 'profiles', 'cos', 'reasoning'] },
  'nav.settings.security': { aliases: ['security', 'password', 'auth', 'settings-security', 'login-password', 'auth-password', 'password-settings'], keywords: ['security', 'password', 'instance password', 'login', 'auth', 'authentication', 'sign-in', 'lock', 'tailnet', 'network security', 'sidecar'] },
  'nav.capabilities': { aliases: ['setup', 'onboarding', 'walkthrough', 'capabilities', 'capability-map', 'integrations'], keywords: ['first run', 'status', 'setup', 'checklist', 'tailscale', 'https', 'dns', 'providers', 'connected systems', 'integrations', 'health overview'] },
  'nav.settings.sharing': { aliases: ['settings-sharing', 'sharing-settings'], keywords: ['display name', 'bio', 'attribution', 'identity', 'source'] },
  'nav.settings.software': { aliases: ['software', 'installed-software', 'software-updates', 'components', 'settings-software', 'dependencies'], keywords: ['installed', 'version', 'update', 'upgrade', 'node', 'nvm', 'pm2', 'chrome', 'browser', 'harness', 'cli', 'ollama', 'lm studio', 'yt-dlp', 'blender', 'supercollider', 'docker', 'conda'] },
  'nav.settings.telegram': { aliases: ['settings-telegram', 'telegram'] },
  'nav.settings.voice': { aliases: ['settings-voice', 'voice', 'voice-settings'], keywords: ['mic', 'microphone', 'speech', 'tts', 'whisper', 'kokoro'] },
  'nav.settings.facetime': { aliases: ['facetime', 'facetime-audio', 'call-settings'], keywords: ['facetime', 'audio call', 'call', 'hang up', 'blackhole'] },
  'nav.settings.call-host': { aliases: ['call-host', 'voice-call-host', 'facetime-call-host', 'audio-bridge', 'meeting-capture', 'capture-audio'], keywords: ['facetime', 'call audio', 'blackhole', 'bridge', 'attach', 'microphone', 'speaker', 'call host', 'meeting capture', 'transcribe meeting', 'record meeting'] },
  'nav.ambient': { aliases: ['ambient', 'ambient-mode', 'ambient mode'], keywords: ['idle', 'background', 'display', 'screensaver', 'fullscreen'] },
  'nav.data': { aliases: ['data'] },
  'nav.instances': { aliases: ['instances'] },
  'nav.loops': { aliases: ['loops'] },
  'nav.devtools.processes': { aliases: ['devtools-processes', 'processes'] },
  'nav.devtools.agents': { aliases: ['ai-agents', 'devtools'] },
  'nav.security': { aliases: ['security-camera', 'camera-monitor', 'security-feed'], keywords: ['camera', 'webcam', 'microphone', 'audio level', 'feed'] },
  'nav.system-health': { aliases: ['system-resources', 'system-health', 'system-status', 'memory-usage', 'cpu-usage'], keywords: ['health', 'memory', 'cpu', 'disk', 'thresholds', 'top processes', 'resource usage', 'build', 'commit', 'running build', 'stale build', 'which code is running'] },
  'nav.system-resources.storage': { aliases: ['disk-usage', 'storage-report', 'disk-cleanup'], keywords: ['disk', 'storage', 'space', 'cleanup', 'cache', 'data usage', 'ai triage'] },
  'nav.system-resources.queues': { aliases: ['active-queues', 'job-queues', 'pending-jobs', 'render-queue'], keywords: ['media jobs', 'agent tasks', 'pending', 'running', 'cancel', 'run now'] },
  'nav.uploads': { aliases: ['uploads'] },
  'nav.wiki.overview': { aliases: ['wiki'] },
  'nav.wiki.browse': { aliases: ['wiki-browse'] },
  'nav.wiki.search': { aliases: ['wiki-search'] },
  'nav.wiki.graph': { aliases: ['wiki-graph'] },
  'nav.wiki.log': { aliases: ['wiki-log'] },
});

export const NAV_COMMANDS_WITH_SEARCH = Object.freeze(
  NAV_COMMANDS.map((cmd) => ({ ...cmd, ...(NAV_SEARCH_METADATA[cmd.id] || {}) })),
);

// Alias collisions resolve to the first-declared entry; ordering is load-bearing.
const aliasToPath = {};
for (const cmd of NAV_COMMANDS_WITH_SEARCH) {
  for (const alias of (cmd.aliases || [])) {
    if (!aliasToPath[alias]) aliasToPath[alias] = cmd.path;
  }
}

export const getNavAliasMap = () => ({ ...aliasToPath });

// Derive lookup keys using the same normalization as spoken input. Keep the
// original alias for getNavAliasMap(), matched, and command ownership lookup.
const normalizeNavAlias = (alias) => normalizeLabel(alias).replace(/\s+/g, '-');
const normalizedAliases = new Map();
for (const alias of Object.keys(aliasToPath)) {
  const key = normalizeNavAlias(alias);
  if (!normalizedAliases.has(key)) normalizedAliases.set(key, alias);
}
const ALIAS_KEYS = [...normalizedAliases.keys()];

// "<section> <label>" as shown in the sidebar and ⌘K ("chief of staff agents",
// "brain daily log"). Without this, the prefix tier below matches the section's
// own short alias (`chief-of-staff`, `brain`) and lands on that section's first
// page. Declared aliases keep precedence; first-declared phrase wins.
const sectionLabelCommands = new Map();
for (const cmd of NAV_COMMANDS_WITH_SEARCH) {
  if (!cmd.section || !cmd.label) continue;
  const key = normalizeNavAlias(`${cmd.section} ${cmd.label}`);
  if (!normalizedAliases.has(key) && !sectionLabelCommands.has(key)) sectionLabelCommands.set(key, cmd);
}

const commandsByPath = new Map();
for (const cmd of NAV_COMMANDS_WITH_SEARCH) {
  if (!commandsByPath.has(cmd.path)) commandsByPath.set(cmd.path, cmd);
}

export const resolveNavCommand = (input) => {
  if (!input || typeof input !== 'string') return null;
  const norm = normalizeNavAlias(input);
  if (!norm) return null;
  const sectionLabelHit = sectionLabelCommands.get(norm);
  if (sectionLabelHit) {
    return { path: sectionLabelHit.path, matched: `${sectionLabelHit.section} ${sectionLabelHit.label}`, command: sectionLabelHit };
  }

  // Exact declared alias match keeps precedence.
  const exactAlias = normalizedAliases.get(norm);
  if (exactAlias) {
    const path = aliasToPath[exactAlias];
    const command = NAV_COMMANDS_WITH_SEARCH.find((c) => c.path === path && (c.aliases || []).includes(exactAlias))
      || NAV_COMMANDS_WITH_SEARCH.find((c) => c.path === path);
    return { path, matched: exactAlias, command };
  }

  // Section-alias + subpath ("digital twin goals" -> /digital-twin/goals).
  // Runs before the prefix tier so the section alias doesn't hijack the page.
  // Applies only to section-root aliases whose segment matches the alias, keeping
  // the longest matching prefix when multiple section aliases qualify.
  let subpathHit = null;
  for (const a of ALIAS_KEYS) {
    if (norm.startsWith(`${a}-`)) {
      const rest = norm.slice(a.length + 1);
      const origAlias = normalizedAliases.get(a);
      const targetPath = aliasToPath[origAlias];
      const base = targetPath?.split('?')[0].split('/').filter(Boolean)[0];
      if (base && base === a) {
        const candidatePath = `/${base}/${rest}`;
        const command = commandsByPath.get(candidatePath);
        if (command && (!subpathHit || a.length > subpathHit.alias.length)) {
          subpathHit = {
            path: candidatePath,
            matched: `${origAlias.replace(/-/g, ' ')} ${rest.replace(/-/g, ' ')}`,
            command,
            alias: a,
          };
        }
      }
    }
  }
  if (subpathHit) {
    return { path: subpathHit.path, matched: subpathHit.matched, command: subpathHit.command };
  }

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

  matched = normalizedAliases.get(matched);
  const path = aliasToPath[matched];
  const command = NAV_COMMANDS_WITH_SEARCH.find((c) => c.path === path && (c.aliases || []).includes(matched))
    || NAV_COMMANDS_WITH_SEARCH.find((c) => c.path === path);
  return { path, matched, command };
};
