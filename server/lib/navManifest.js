// Single source of truth for PortOS navigation. Consumed by
// server/services/voice/tools.js#ui_navigate and the Cmd+K palette.
// Entry: { id, path, label, section, aliases?, keywords? }. See CLAUDE.md
// "Command Palette & Voice Nav" for the contract.

export const NAV_COMMANDS = [
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main', aliases: ['dashboard', 'home'], keywords: ['overview', 'start'] },
  { id: 'nav.review-hub', path: '/review', label: 'Review Hub', section: 'Main', aliases: ['review', 'review-hub'] },
  { id: 'nav.cybercity', path: '/city', label: 'CyberCity', section: 'Main', aliases: ['city', 'cybercity'], keywords: ['3d', 'visualization'] },
  { id: 'nav.cybercity.settings', path: '/city/settings', label: 'CyberCity Settings', section: 'Main', aliases: ['city settings', 'cybercity settings', 'city-settings', 'cybercity-config'], keywords: ['cybercity', 'settings', '3d', 'configure'] },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'Main', aliases: ['apps'] },

  { id: 'nav.catalog', path: '/catalog', label: 'Catalog', section: 'Create', aliases: ['catalog', 'ingredients', 'cast', 'creative-catalog'], keywords: ['character', 'place', 'object', 'idea', 'scene', 'concept', 'inventory', 'reference', 'creative'] },
  { id: 'nav.catalog.ingest', path: '/catalog/ingest', label: 'Catalog Ingest', section: 'Create', aliases: ['catalog-ingest', 'ingest', 'paste-scrap', 'extract-ingredients'], keywords: ['paste', 'snippet', 'scene', 'idea', 'extract', 'scrap', 'import-catalog'] },
  { id: 'nav.media', path: '/media/image', label: 'Media Gen', section: 'Create', aliases: ['media', 'media-gen', 'mediagen', 'generate'], keywords: ['image', 'video', 'render', 'art', 'movie'] },
  { id: 'nav.media.image', path: '/media/image', label: 'Image', section: 'Create', aliases: ['image-gen', 'imagegen', 'generate-image', 'sd', 'stable-diffusion'], keywords: ['stable diffusion', 'render', 'art', 'picture', 'photo', 'draw', 'flux', 'mflux'] },
  { id: 'nav.media.video', path: '/media/video', label: 'Video', section: 'Create', aliases: ['video-gen', 'videogen', 'generate-video', 'ltx'], keywords: ['video', 'animate', 'movie', 'clip', 'ltx'] },
  { id: 'nav.media.history', path: '/media/history', label: 'Media History', section: 'Create', aliases: ['media-history', 'video-history'], keywords: ['videos', 'gallery', 'stitch'] },
  { id: 'nav.media.collections', path: '/media/collections', label: 'Collections', section: 'Create', aliases: ['collections', 'media-collections', 'stacks', 'projects'], keywords: ['bucket', 'group', 'project', 'album', 'organize'] },
  { id: 'nav.media.creative-director', path: '/media/creative-director', label: 'Creative Director', section: 'Create', aliases: ['creative-director', 'creative', 'director', 'long-form', 'episode'], keywords: ['story', 'episode', 'narrative', 'agent', 'auto-video', 'long-form'] },
  { id: 'nav.media.timeline', path: '/media/timeline', label: 'Timeline', section: 'Create', aliases: ['timeline', 'video-timeline', 'editor'], keywords: ['edit', 'trim', 'composite', 'stitch', 'cut', 'compose'] },
  { id: 'nav.media.models', path: '/media/models', label: 'Media Models', section: 'Create', aliases: ['media-models', 'image-models', 'video-models', 'huggingface'], keywords: ['hf cache', 'model storage', 'disk'] },
  { id: 'nav.create.universe-builder', path: '/universes', label: 'Universes', section: 'Create', aliases: ['universes', 'universe', 'universe-builder', 'worldbuilder', 'worldbuild', 'world', 'lore', 'universe-canon', 'canon'], keywords: ['style template', 'sci-fi', 'fantasy', 'concept art', 'batch render', 'variations', 'characters', 'settings', 'objects', 'canon entries', 'list', 'manage'] },
  { id: 'nav.create.importer', path: '/importer', label: 'Importer', section: 'Create', aliases: ['importer', 'import'], keywords: ['paste', 'screenplay', 'novel', 'short story', 'comic script', 'analyze', 'reverse-engineer', 'extract'] },
  { id: 'nav.create.pipeline', path: '/pipeline', label: 'Series Pipeline', section: 'Create', aliases: ['series', 'pipeline', 'production', 'series-pipeline', 'production-pipeline'], keywords: ['series', 'issue', 'episode', 'comic', 'script', 'prose', 'storyboard', 'narrative', 'workflow'] },
  { id: 'nav.create.sharing', path: '/sharing', label: 'Sharing', section: 'Create', aliases: ['sharing', 'share', 'buckets', 'share-buckets'], keywords: ['google drive', 'dropbox', 'icloud', 'syncthing', 'export', 'import', 'collaborate', 'federation', 'peer', 'cross-network'] },
  { id: 'nav.create.sharing-duplicates', path: '/sharing/duplicates', label: 'Duplicates', section: 'Create', aliases: ['duplicates', 'duplicate-universes', 'duplicate-series', 'dedupe', 'merge-duplicates'], keywords: ['duplicate', 'merge', 'rename', 'same name', 'two copies', 'reconcile', 'collision'] },
  { id: 'nav.create.story-builder', path: '/story-builder', label: 'Story Builder', section: 'Create', aliases: ['story-builder', 'storybuilder', 'guided', 'new-story', 'story-wizard'], keywords: ['idea', 'universe', 'arc', 'reader map', 'guided', 'wizard', 'linear', 'lock', 'front door', 'episode', 'series'] },
  { id: 'nav.create.sharing-conflicts', path: '/sharing/conflicts', label: 'Conflicts', section: 'Create', aliases: ['conflicts', 'sync-conflicts', 'edit-conflicts', 'conflict-journal'], keywords: ['conflict', 'overwrite', 'lost edit', 'restore', 'merge fields', 'last write wins', 'diverged', 'recover'] },
  { id: 'nav.media.loras', path: '/media/loras', label: 'LoRAs', section: 'Create', aliases: ['loras', 'lora', 'lora-manager', 'civitai'], keywords: ['lora', 'civitai', 'fine-tune', 'style adapter', 'realstagram', 'photoreal', 'flux lora'] },
  { id: 'nav.media.settings', path: '/media/image?settings=1', label: 'Media Gen Settings', section: 'Create', aliases: ['media-settings', 'image-gen-settings', 'sd-settings', 'video-gen-settings'] },
  { id: 'nav.writers-room', path: '/writers-room', label: 'Writers Room', section: 'Create', aliases: ['writers-room', 'writersroom', 'writer', 'write', 'studio', 'novel'], keywords: ['prose', 'screenplay', 'story', 'draft', 'manuscript', 'literary', 'novel', 'short story'] },
  { id: 'nav.writers-room.guide', path: '/writers-room/guide', label: 'Writers Room Guide', section: 'Create', aliases: ['writers-room-guide', 'writing-guide', 'writing-rules', 'word-count', 'length-targets'], keywords: ['microfiction', 'flash fiction', 'short story', 'novelette', 'novella', 'novel length', 'word count', 'character count', 'book length', 'craft', 'writing advice', 'emotional roadmap', 'documentation', 'help'] },
  { id: 'nav.settings.prompts', path: '/prompts', label: 'Prompts', section: 'Settings', aliases: ['prompts'] },
  { id: 'nav.settings.providers', path: '/ai', label: 'Providers', section: 'Settings', aliases: ['providers', 'ai-providers'] },

  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Inbox', section: 'Brain', aliases: ['brain', 'brain-inbox', 'inbox'] },
  { id: 'nav.brain.config', path: '/brain/config', label: 'Config', section: 'Brain', aliases: ['brain-config'] },
  { id: 'nav.brain.daily-log', path: '/brain/daily-log', label: 'Daily Log', section: 'Brain', aliases: ['daily-log', 'journal'] },
  { id: 'nav.brain.digest', path: '/brain/digest', label: 'Digest', section: 'Brain', aliases: ['brain-digest'] },
  { id: 'nav.brain.feeds', path: '/brain/feeds', label: 'Feeds', section: 'Brain', aliases: ['brain-feeds', 'feeds', 'rss'], keywords: ['rss', 'subscriptions'] },
  { id: 'nav.brain.graph', path: '/brain/graph', label: 'Graph', section: 'Brain', aliases: ['brain-graph'] },
  { id: 'nav.brain.import', path: '/brain/import', label: 'Import', section: 'Brain', aliases: ['brain-import', 'import-chatgpt', 'chatgpt-import'], keywords: ['chatgpt', 'openai', 'export', 'third-party'] },
  { id: 'nav.insights', path: '/insights/overview', label: 'Insights', section: 'Brain', aliases: ['insights'] },
  { id: 'nav.insights.genome-health', path: '/insights/genome-health', label: 'Genome-Health', section: 'Brain', aliases: ['genome-health', 'insights-genome-health'], keywords: ['genome', 'dna', 'health', 'longevity', 'genetic'] },
  { id: 'nav.insights.taste-identity', path: '/insights/taste-identity', label: 'Taste & Identity', section: 'Brain', aliases: ['taste-identity', 'insights-taste-identity'], keywords: ['taste', 'identity', 'preferences', 'aesthetic'] },
  { id: 'nav.insights.cross-domain', path: '/insights/cross-domain', label: 'Cross-Domain Patterns', section: 'Brain', aliases: ['cross-domain', 'insights-cross-domain', 'cross-domain-patterns'], keywords: ['cross domain', 'patterns', 'correlations', 'connections'] },
  { id: 'nav.brain.links', path: '/brain/links', label: 'Links', section: 'Brain', aliases: ['brain-links'] },
  { id: 'nav.brain.memory', path: '/brain/memory', label: 'Memory', section: 'Brain', aliases: ['brain-memory', 'memory'] },
  { id: 'nav.brain.notes', path: '/brain/notes', label: 'Notes', section: 'Brain', aliases: ['brain-notes', 'notes'] },
  { id: 'nav.rapid-reader', path: '/rapid-reader', label: 'Rapid Reader', section: 'Brain', aliases: ['rapid-reader', 'speed-reader', 'rsvp', 'spritz'], keywords: ['speed reading', 'rapid reading', 'rsvp', 'spritz', 'word per minute', 'wpm', 'focal'] },
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
  { id: 'nav.cos.gsd', path: '/cos/gsd', label: 'GSD', section: 'Chief of Staff', aliases: ['gsd', 'cos-gsd'] },
  { id: 'nav.cos.health', path: '/cos/health', label: 'Health', section: 'Chief of Staff', aliases: ['cos-health', 'health'] },
  { id: 'nav.cos.learning', path: '/cos/learning', label: 'Learning', section: 'Chief of Staff', aliases: ['cos-learning'] },
  { id: 'nav.cos.memory', path: '/cos/memory', label: 'Memory', section: 'Chief of Staff', aliases: ['cos-memory'] },
  { id: 'nav.cos.schedule', path: '/cos/schedule', label: 'Schedule', section: 'Chief of Staff', aliases: ['schedule', 'cos-schedule'] },
  // Note: `pipeline` is intentionally NOT an alias here — that token now
  // resolves to the dedicated /pipeline page (nav.create.pipeline). CoS still
  // surfaces "task pipeline" via the `pipeline` keyword in the palette.
  { id: 'nav.cos.workflow', path: '/cos/workflow', label: 'Workflow', section: 'Chief of Staff', aliases: ['workflow', 'cos-workflow'], keywords: ['pipeline', 'dependencies', 'order', 'stages', 'task pipeline'] },
  { id: 'nav.cos.productivity', path: '/cos/productivity', label: 'Streaks', section: 'Chief of Staff', aliases: ['streaks', 'cos-productivity'] },

  { id: 'nav.messages.inbox', path: '/messages/inbox', label: 'Inbox', section: 'Comms', aliases: ['messages'] },
  { id: 'nav.messages.drafts', path: '/messages/drafts', label: 'Drafts', section: 'Comms', aliases: ['drafts'] },
  { id: 'nav.messages.config', path: '/messages/config', label: 'Config', section: 'Comms', aliases: ['messages-config'] },
  { id: 'nav.messages.sync', path: '/messages/sync', label: 'Sync', section: 'Comms', aliases: ['messages-sync'] },
  { id: 'nav.openclaw', path: '/openclaw', label: 'OpenClaw', section: 'Comms', aliases: ['openclaw'] },
  { id: 'nav.social-agents', path: '/agents', label: 'Social Agents', section: 'Comms', aliases: ['social-agents'] },

  { id: 'nav.devtools.runs', path: '/devtools/runs', label: 'AI Runs', section: 'Dev Tools', aliases: ['ai-runs', 'devtools'] },
  { id: 'nav.devtools.agents', path: '/devtools/agents', label: 'AI Agents', section: 'Dev Tools', aliases: ['ai-agents'] },
  { id: 'nav.browser', path: '/browser', label: 'Browser', section: 'Dev Tools', aliases: ['browser'] },
  { id: 'nav.devtools.runner', path: '/devtools/runner', label: 'Code', section: 'Dev Tools', aliases: ['devtools-runner'] },
  { id: 'nav.devtools.datadog', path: '/devtools/datadog', label: 'DataDog', section: 'Dev Tools', aliases: ['datadog', 'devtools-datadog'] },
  { id: 'nav.feature-agents', path: '/feature-agents', label: 'Feature Agents', section: 'Dev Tools', aliases: ['feature-agents'] },
  { id: 'nav.devtools.github', path: '/devtools/github', label: 'GitHub', section: 'Dev Tools', aliases: ['github', 'devtools-github'] },
  { id: 'nav.devtools.history', path: '/devtools/history', label: 'History', section: 'Dev Tools', aliases: ['devtools-history'] },
  { id: 'nav.devtools.image-clean', path: '/devtools/image-clean', label: 'Image Cleaner', section: 'Dev Tools', aliases: ['image-clean', 'image-cleaner'], keywords: ['metadata', 'c2pa', 'content-credentials', 'sharp', 'denoise'] },
  { id: 'nav.devtools.jira', path: '/devtools/jira', label: 'JIRA', section: 'Dev Tools', aliases: ['jira', 'devtools-jira'] },
  { id: 'nav.devtools.jira-reports', path: '/devtools/jira/reports', label: 'JIRA Reports', section: 'Dev Tools', aliases: ['jira-reports'] },
  { id: 'nav.shell', path: '/shell', label: 'Shell', section: 'Dev Tools', aliases: ['shell', 'terminal'] },
  { id: 'nav.devtools.submodules', path: '/devtools/submodules', label: 'Submodules', section: 'Dev Tools', aliases: ['devtools-submodules'] },
  { id: 'nav.devtools.usage', path: '/devtools/usage', label: 'Usage', section: 'Dev Tools', aliases: ['devtools-usage'] },

  { id: 'nav.twin.overview', path: '/digital-twin/overview', label: 'Overview', section: 'Digital Twin', aliases: ['digital-twin', 'twin'] },
  { id: 'nav.twin.accounts', path: '/digital-twin/accounts', label: 'Accounts', section: 'Digital Twin', aliases: ['twin-accounts'] },
  { id: 'nav.ask', path: '/ask', label: 'Ask Yourself', section: 'Digital Twin', aliases: ['ask', 'ask-yourself', 'twin-chat'], keywords: ['chat', 'twin', 'conversation', 'advise', 'draft'] },
  { id: 'nav.twin.autobiography', path: '/digital-twin/autobiography', label: 'Autobiography', section: 'Digital Twin', aliases: ['twin-autobiography', 'autobiography'] },
  { id: 'nav.character', path: '/character', label: 'Character', section: 'Digital Twin', aliases: ['character'] },
  { id: 'nav.twin.documents', path: '/digital-twin/documents', label: 'Documents', section: 'Digital Twin', aliases: ['twin-documents'] },
  { id: 'nav.twin.enrich', path: '/digital-twin/enrich', label: 'Enrich', section: 'Digital Twin', aliases: ['twin-enrich'] },
  { id: 'nav.twin.export', path: '/digital-twin/export', label: 'Export', section: 'Digital Twin', aliases: ['twin-export'] },
  { id: 'nav.goals', path: '/goals/list', label: 'Goals', section: 'Digital Twin', aliases: ['goals'] },
  { id: 'nav.goals.tree', path: '/goals/tree', label: 'Goals Tree', section: 'Digital Twin', aliases: ['goals-tree', 'goal-tree'], keywords: ['hierarchy', 'decomposition', 'subgoals', 'breakdown'] },
  { id: 'nav.twin.goals', path: '/digital-twin/goals', label: 'Twin Goals', section: 'Digital Twin', aliases: ['twin-goals'] },
  { id: 'nav.twin.identity', path: '/digital-twin/identity', label: 'Identity', section: 'Digital Twin', aliases: ['twin-identity', 'identity'] },
  { id: 'nav.twin.import', path: '/digital-twin/import', label: 'Import', section: 'Digital Twin', aliases: ['twin-import'] },
  { id: 'nav.twin.interview', path: '/digital-twin/interview', label: 'Interview', section: 'Digital Twin', aliases: ['twin-interview'] },
  { id: 'nav.twin.taste', path: '/digital-twin/taste', label: 'Taste', section: 'Digital Twin', aliases: ['twin-taste'] },
  { id: 'nav.twin.test', path: '/digital-twin/test', label: 'Test', section: 'Digital Twin', aliases: ['twin-test'] },
  { id: 'nav.twin.time-capsule', path: '/digital-twin/time-capsule', label: 'Time Capsule', section: 'Digital Twin', aliases: ['time-capsule', 'twin-time-capsule', 'capsule'], keywords: ['legacy', 'archive', 'snapshot'] },

  { id: 'nav.meatspace.overview', path: '/meatspace/overview', label: 'Overview', section: 'MeatSpace', aliases: ['meatspace'] },
  { id: 'nav.meatspace.health', path: '/meatspace/health', label: 'Body Health', section: 'MeatSpace', aliases: ['meatspace-health', 'body-health'], keywords: ['health', 'vitals', 'wellbeing', 'biometrics'] },
  { id: 'nav.meatspace.body', path: '/meatspace/body', label: 'Body', section: 'MeatSpace', aliases: ['meatspace-body', 'body'] },
  { id: 'nav.meatspace.alcohol', path: '/meatspace/alcohol', label: 'Alcohol', section: 'MeatSpace', aliases: ['meatspace-alcohol', 'alcohol'] },
  { id: 'nav.meatspace.nicotine', path: '/meatspace/nicotine', label: 'Nicotine', section: 'MeatSpace', aliases: ['meatspace-nicotine', 'nicotine'] },
  { id: 'nav.meatspace.age', path: '/meatspace/age', label: 'Age', section: 'MeatSpace', aliases: ['meatspace-age'] },
  { id: 'nav.meatspace.blood', path: '/meatspace/blood', label: 'Blood', section: 'MeatSpace', aliases: ['meatspace-blood', 'blood'] },
  { id: 'nav.meatspace.genome', path: '/meatspace/genome', label: 'Genome', section: 'MeatSpace', aliases: ['meatspace-genome', 'genome'] },
  { id: 'nav.meatspace.lifestyle', path: '/meatspace/lifestyle', label: 'Lifestyle', section: 'MeatSpace', aliases: ['meatspace-lifestyle', 'lifestyle'] },
  { id: 'nav.meatspace.settings', path: '/meatspace/settings', label: 'Settings', section: 'MeatSpace', aliases: ['meatspace-settings'] },

  { id: 'nav.post.launcher', path: '/post/launcher', label: 'Launcher', section: 'POST', aliases: ['post', 'post-launcher'] },
  { id: 'nav.post.config', path: '/post/config', label: 'Config', section: 'POST', aliases: ['post-config'] },
  { id: 'nav.post.history', path: '/post/history', label: 'History', section: 'POST', aliases: ['post-history'] },
  { id: 'nav.post.memory', path: '/post/memory', label: 'Memory', section: 'POST', aliases: ['post-memory'] },
  { id: 'nav.post.morse', path: '/post/morse', label: 'Morse', section: 'POST', aliases: ['post-morse', 'morse', 'morse-code'], keywords: ['cw', 'ham', 'radio', 'koch', 'cognitive'] },
  { id: 'nav.post.wordplay', path: '/post/wordplay', label: 'Wordplay', section: 'POST', aliases: ['post-wordplay'] },

  { id: 'nav.settings.ai-assignments', path: '/settings/ai-assignments', label: 'AI Assignments', section: 'Settings', aliases: ['ai-assignments', 'assignments', 'settings-ai-assignments', 'ai-inventory'], keywords: ['provider', 'model', 'pin', 'inventory', 'migration', 'llm'] },
  { id: 'nav.settings.autofixer', path: '/settings/autofixer', label: 'Autofixer', section: 'Settings', aliases: ['autofixer', 'settings-autofixer', 'auto-fixer'], keywords: ['crash', 'fix', 'pm2', 'repair', 'ai provider', 'restart'] },
  { id: 'nav.settings.backup', path: '/settings/backup', label: 'Backup', section: 'Settings', aliases: ['backup', 'settings-backup'] },
  { id: 'nav.settings.catalog', path: '/settings/catalog', label: 'Catalog Types', section: 'Settings', aliases: ['settings-catalog', 'catalog-types'], keywords: ['catalog', 'types', 'character', 'place', 'object', 'taxonomy'] },
  { id: 'nav.settings.database', path: '/settings/database', label: 'Database', section: 'Settings', aliases: ['settings-database', 'database'] },
  { id: 'nav.settings.embeddings', path: '/settings/embeddings', label: 'Embeddings', section: 'Settings', aliases: ['settings-embeddings', 'embeddings', 'embedding'], keywords: ['vector', 'pgvector', 'semantic search', 'nomic', 'ollama', 'lm studio'] },
  { id: 'nav.settings.general', path: '/settings/general', label: 'General', section: 'Settings', aliases: ['settings', 'settings-general', 'general'] },
  { id: 'nav.settings.local-llm', path: '/settings/local-llm', label: 'Local LLMs', section: 'Settings', aliases: ['local-llm', 'local-llms', 'ollama', 'lm-studio', 'lmstudio'], keywords: ['ollama', 'lm studio', 'local model', 'local llm', 'gguf', 'pull model', 'install model', 'migrate', 'switch backend'] },
  { id: 'nav.settings.local-llm-playground', path: '/local-llm/playground', label: 'Local LLM Playground', section: 'Settings', aliases: ['llm-playground', 'playground', 'model-playground', 'compare-models'], keywords: ['ollama', 'lm studio', 'compare', 'benchmark', 'chat', 'test model', 'ttft', 'tokens per second', 'local llm'] },
  { id: 'nav.settings.mortalloom', path: '/settings/mortalloom', label: 'MortalLoom', section: 'Settings', aliases: ['settings-mortalloom', 'mortalloom'] },
  { id: 'nav.settings.sharing', path: '/settings/sharing', label: 'Sharing', section: 'Settings', aliases: ['settings-sharing', 'sharing-settings'], keywords: ['display name', 'bio', 'attribution', 'identity', 'source'] },
  { id: 'nav.settings.telegram', path: '/settings/telegram', label: 'Telegram', section: 'Settings', aliases: ['settings-telegram', 'telegram'] },
  { id: 'nav.settings.voice', path: '/settings/voice', label: 'Voice', section: 'Settings', aliases: ['settings-voice', 'voice', 'voice-settings'], keywords: ['mic', 'microphone', 'speech', 'tts', 'whisper', 'kokoro'] },

  { id: 'nav.ambient', path: '/ambient', label: 'Ambient', section: 'System', aliases: ['ambient', 'ambient-mode', 'ambient mode'], keywords: ['idle', 'background', 'display', 'screensaver', 'fullscreen'] },
  { id: 'nav.capabilities', path: '/capabilities', label: 'Capabilities', section: 'System', aliases: ['capabilities', 'capability-map', 'integrations'], keywords: ['status', 'setup', 'checklist', 'connected systems', 'integrations', 'providers', 'health overview'] },
  { id: 'nav.data', path: '/data', label: 'Data', section: 'System', aliases: ['data'] },
  { id: 'nav.instances', path: '/instances', label: 'Instances', section: 'System', aliases: ['instances'] },
  { id: 'nav.loops', path: '/loops', label: 'Loops', section: 'System', aliases: ['loops'] },
  { id: 'nav.devtools.processes', path: '/devtools/processes', label: 'Processes', section: 'System', aliases: ['devtools-processes', 'processes'] },
  { id: 'nav.security', path: '/security', label: 'Security', section: 'System', aliases: ['security'] },
  { id: 'nav.system-health', path: '/system-health', label: 'System Health', section: 'System', aliases: ['system-health', 'system-status', 'memory-usage', 'disk-usage', 'cpu-usage'], keywords: ['memory', 'cpu', 'disk', 'thresholds', 'top processes', 'resource usage'] },
  { id: 'nav.cos.jobs', path: '/cos/jobs', label: 'System Tasks', section: 'System', aliases: ['cos-jobs', 'system-tasks'] },
  { id: 'nav.uploads', path: '/uploads', label: 'Uploads', section: 'System', aliases: ['uploads'] },

  { id: 'nav.wiki.overview', path: '/wiki/overview', label: 'Overview', section: 'Wiki', aliases: ['wiki'] },
  { id: 'nav.wiki.browse', path: '/wiki/browse', label: 'Browse', section: 'Wiki', aliases: ['wiki-browse'] },
  { id: 'nav.wiki.graph', path: '/wiki/graph', label: 'Graph', section: 'Wiki', aliases: ['wiki-graph'] },
  { id: 'nav.wiki.log', path: '/wiki/log', label: 'Log', section: 'Wiki', aliases: ['wiki-log'] },
  { id: 'nav.wiki.search', path: '/wiki/search', label: 'Search', section: 'Wiki', aliases: ['wiki-search'] },
];

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
