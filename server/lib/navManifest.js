// Single source of truth for PortOS navigation commands.
//
// Consumed by:
//   - server/services/voice/tools.js#ui_navigate (voice agent resolves "take me to tasks")
//   - server/routes/palette.js (Cmd+K palette fetches the manifest)
//   - client/src/components/CmdKSearch.jsx (renders nav commands in the palette)
//
// Adding a page to the sidebar? Add an entry here first; voice + palette pick it up automatically.
//
// Entry shape:
//   { id, path, label, section, aliases?: string[], keywords?: string[] }
//
// - id: stable machine identifier ("nav.brain.inbox"); used by the palette + action dispatch.
// - path: exact route the client router resolves.
// - label: human-readable name shown in the palette.
// - section: grouping label; matches the sidebar section so the palette and sidebar agree on structure.
// - aliases: short spoken/typed tokens the user is likely to say ("inbox", "cos", "twin"). Fuzzy matcher tries exact alias first.
// - keywords: extra terms for the palette's in-UI fuzzy search (synonyms, context words).

export const NAV_COMMANDS = [
  // ── Main (sidebar singletons) ─────────────────────────────────────────
  { id: 'nav.dashboard', path: '/', label: 'Dashboard', section: 'Main', aliases: ['dashboard', 'home'], keywords: ['overview', 'start'] },
  { id: 'nav.review-hub', path: '/review', label: 'Review Hub', section: 'Main', aliases: ['review', 'review-hub'] },
  { id: 'nav.cybercity', path: '/city', label: 'CyberCity', section: 'Main', aliases: ['city', 'cybercity'], keywords: ['3d', 'visualization'] },
  { id: 'nav.character', path: '/character', label: 'Character', section: 'Main', aliases: ['character'] },
  { id: 'nav.data', path: '/data', label: 'Data', section: 'Main', aliases: ['data'] },
  { id: 'nav.goals', path: '/goals/list', label: 'Goals', section: 'Main', aliases: ['goals'] },
  { id: 'nav.insights', path: '/insights/overview', label: 'Insights', section: 'Main', aliases: ['insights'] },
  { id: 'nav.openclaw', path: '/openclaw', label: 'OpenClaw', section: 'Main', aliases: ['openclaw'] },
  { id: 'nav.social-agents', path: '/agents', label: 'Social Agents', section: 'Main', aliases: ['social-agents'] },
  { id: 'nav.apps', path: '/apps', label: 'Apps', section: 'Main', aliases: ['apps'] },
  { id: 'nav.shell', path: '/shell', label: 'Shell', section: 'Main', aliases: ['shell', 'terminal'] },
  { id: 'nav.browser', path: '/browser', label: 'Browser', section: 'Main', aliases: ['browser'] },
  { id: 'nav.instances', path: '/instances', label: 'Instances', section: 'Main', aliases: ['instances'] },
  { id: 'nav.loops', path: '/loops', label: 'Loops', section: 'Main', aliases: ['loops'] },

  // ── Brain ─────────────────────────────────────────────────────────────
  { id: 'nav.brain.inbox', path: '/brain/inbox', label: 'Inbox', section: 'Brain', aliases: ['brain', 'brain-inbox', 'inbox'] },
  { id: 'nav.brain.config', path: '/brain/config', label: 'Config', section: 'Brain', aliases: ['brain-config'] },
  { id: 'nav.brain.daily-log', path: '/brain/daily-log', label: 'Daily Log', section: 'Brain', aliases: ['daily-log', 'journal'] },
  { id: 'nav.brain.digest', path: '/brain/digest', label: 'Digest', section: 'Brain', aliases: ['brain-digest'] },
  { id: 'nav.brain.graph', path: '/brain/graph', label: 'Graph', section: 'Brain', aliases: ['brain-graph'] },
  { id: 'nav.brain.links', path: '/brain/links', label: 'Links', section: 'Brain', aliases: ['brain-links'] },
  { id: 'nav.brain.memory', path: '/brain/memory', label: 'Memory', section: 'Brain', aliases: ['brain-memory', 'memory'] },
  { id: 'nav.brain.notes', path: '/brain/notes', label: 'Notes', section: 'Brain', aliases: ['brain-notes', 'notes'] },
  { id: 'nav.brain.trust', path: '/brain/trust', label: 'Trust', section: 'Brain', aliases: ['brain-trust'] },

  // ── Calendar ──────────────────────────────────────────────────────────
  { id: 'nav.calendar.agenda', path: '/calendar/agenda', label: 'Agenda', section: 'Calendar', aliases: ['calendar', 'agenda'] },
  { id: 'nav.calendar.config', path: '/calendar/config', label: 'Config', section: 'Calendar', aliases: ['calendar-config'] },
  { id: 'nav.calendar.day', path: '/calendar/day', label: 'Day', section: 'Calendar', aliases: ['calendar-day'] },
  { id: 'nav.calendar.week', path: '/calendar/week', label: 'Week', section: 'Calendar', aliases: ['calendar-week'] },
  { id: 'nav.calendar.month', path: '/calendar/month', label: 'Month', section: 'Calendar', aliases: ['calendar-month'] },
  { id: 'nav.calendar.lifetime', path: '/calendar/lifetime', label: 'Lifetime', section: 'Calendar', aliases: ['calendar-lifetime'] },
  { id: 'nav.calendar.review', path: '/calendar/review', label: 'Review', section: 'Calendar', aliases: ['calendar-review'] },
  { id: 'nav.calendar.sync', path: '/calendar/sync', label: 'Sync', section: 'Calendar', aliases: ['calendar-sync'] },

  // ── Chief of Staff ────────────────────────────────────────────────────
  { id: 'nav.cos.tasks', path: '/cos/tasks', label: 'Tasks', section: 'Chief of Staff', aliases: ['tasks', 'cos', 'cos-tasks', 'chief-of-staff'] },
  { id: 'nav.cos.agents', path: '/cos/agents', label: 'Agents', section: 'Chief of Staff', aliases: ['agents', 'cos-agents'] },
  { id: 'nav.cos.briefing', path: '/cos/briefing', label: 'Briefing', section: 'Chief of Staff', aliases: ['briefing', 'cos-briefing'] },
  { id: 'nav.cos.config', path: '/cos/config', label: 'Config', section: 'Chief of Staff', aliases: ['cos-config'] },
  { id: 'nav.cos.digest', path: '/cos/digest', label: 'Digest', section: 'Chief of Staff', aliases: ['cos-digest'] },
  { id: 'nav.cos.gsd', path: '/cos/gsd', label: 'GSD', section: 'Chief of Staff', aliases: ['gsd', 'cos-gsd'] },
  { id: 'nav.cos.health', path: '/cos/health', label: 'Health', section: 'Chief of Staff', aliases: ['cos-health'] },
  { id: 'nav.cos.learning', path: '/cos/learning', label: 'Learning', section: 'Chief of Staff', aliases: ['cos-learning'] },
  { id: 'nav.cos.memory', path: '/cos/memory', label: 'Memory', section: 'Chief of Staff', aliases: ['cos-memory'] },
  { id: 'nav.cos.schedule', path: '/cos/schedule', label: 'Schedule', section: 'Chief of Staff', aliases: ['schedule', 'cos-schedule'] },
  { id: 'nav.cos.scripts', path: '/cos/scripts', label: 'Scripts', section: 'Chief of Staff', aliases: ['cos-scripts'] },
  { id: 'nav.cos.productivity', path: '/cos/productivity', label: 'Streaks', section: 'Chief of Staff', aliases: ['streaks', 'cos-productivity'] },
  { id: 'nav.cos.jobs', path: '/cos/jobs', label: 'System Tasks', section: 'Chief of Staff', aliases: ['cos-jobs', 'system-tasks'] },

  // ── Dev Tools ─────────────────────────────────────────────────────────
  { id: 'nav.devtools.runs', path: '/devtools/runs', label: 'AI Runs', section: 'Dev Tools', aliases: ['ai-runs', 'devtools'] },
  { id: 'nav.devtools.agents', path: '/devtools/agents', label: 'AI Agents', section: 'Dev Tools', aliases: ['ai-agents'] },
  { id: 'nav.devtools.runner', path: '/devtools/runner', label: 'Code', section: 'Dev Tools', aliases: ['devtools-runner'] },
  { id: 'nav.devtools.datadog', path: '/devtools/datadog', label: 'DataDog', section: 'Dev Tools', aliases: ['datadog', 'devtools-datadog'] },
  { id: 'nav.devtools.github', path: '/devtools/github', label: 'GitHub', section: 'Dev Tools', aliases: ['github', 'devtools-github'] },
  { id: 'nav.devtools.history', path: '/devtools/history', label: 'History', section: 'Dev Tools', aliases: ['devtools-history'] },
  { id: 'nav.devtools.jira', path: '/devtools/jira', label: 'JIRA', section: 'Dev Tools', aliases: ['jira', 'devtools-jira'] },
  { id: 'nav.devtools.jira-reports', path: '/devtools/jira/reports', label: 'JIRA Reports', section: 'Dev Tools', aliases: ['jira-reports'] },
  { id: 'nav.devtools.processes', path: '/devtools/processes', label: 'Processes', section: 'Dev Tools', aliases: ['devtools-processes'] },
  { id: 'nav.devtools.submodules', path: '/devtools/submodules', label: 'Submodules', section: 'Dev Tools', aliases: ['devtools-submodules'] },
  { id: 'nav.devtools.usage', path: '/devtools/usage', label: 'Usage', section: 'Dev Tools', aliases: ['devtools-usage'] },
  { id: 'nav.feature-agents', path: '/feature-agents', label: 'Feature Agents', section: 'Dev Tools', aliases: ['feature-agents'] },

  // ── Digital Twin ──────────────────────────────────────────────────────
  { id: 'nav.twin.overview', path: '/digital-twin/overview', label: 'Overview', section: 'Digital Twin', aliases: ['digital-twin', 'twin'] },
  { id: 'nav.twin.accounts', path: '/digital-twin/accounts', label: 'Accounts', section: 'Digital Twin', aliases: ['twin-accounts'] },
  { id: 'nav.twin.autobiography', path: '/digital-twin/autobiography', label: 'Autobiography', section: 'Digital Twin', aliases: ['twin-autobiography', 'autobiography'] },
  { id: 'nav.twin.documents', path: '/digital-twin/documents', label: 'Documents', section: 'Digital Twin', aliases: ['twin-documents'] },
  { id: 'nav.twin.enrich', path: '/digital-twin/enrich', label: 'Enrich', section: 'Digital Twin', aliases: ['twin-enrich'] },
  { id: 'nav.twin.export', path: '/digital-twin/export', label: 'Export', section: 'Digital Twin', aliases: ['twin-export'] },
  { id: 'nav.twin.goals', path: '/digital-twin/goals', label: 'Goals', section: 'Digital Twin', aliases: ['twin-goals'] },
  { id: 'nav.twin.identity', path: '/digital-twin/identity', label: 'Identity', section: 'Digital Twin', aliases: ['twin-identity', 'identity'] },
  { id: 'nav.twin.import', path: '/digital-twin/import', label: 'Import', section: 'Digital Twin', aliases: ['twin-import'] },
  { id: 'nav.twin.interview', path: '/digital-twin/interview', label: 'Interview', section: 'Digital Twin', aliases: ['twin-interview'] },
  { id: 'nav.twin.taste', path: '/digital-twin/taste', label: 'Taste', section: 'Digital Twin', aliases: ['twin-taste'] },
  { id: 'nav.twin.test', path: '/digital-twin/test', label: 'Test', section: 'Digital Twin', aliases: ['twin-test'] },

  // ── MeatSpace ─────────────────────────────────────────────────────────
  { id: 'nav.meatspace.overview', path: '/meatspace/overview', label: 'Overview', section: 'MeatSpace', aliases: ['meatspace'] },
  { id: 'nav.meatspace.health', path: '/meatspace/health', label: 'Health', section: 'MeatSpace', aliases: ['meatspace-health', 'health'] },
  { id: 'nav.meatspace.body', path: '/meatspace/body', label: 'Body', section: 'MeatSpace', aliases: ['meatspace-body', 'body'] },
  { id: 'nav.meatspace.alcohol', path: '/meatspace/alcohol', label: 'Alcohol', section: 'MeatSpace', aliases: ['meatspace-alcohol', 'alcohol'] },
  { id: 'nav.meatspace.nicotine', path: '/meatspace/nicotine', label: 'Nicotine', section: 'MeatSpace', aliases: ['meatspace-nicotine', 'nicotine'] },
  { id: 'nav.meatspace.age', path: '/meatspace/age', label: 'Age', section: 'MeatSpace', aliases: ['meatspace-age'] },
  { id: 'nav.meatspace.blood', path: '/meatspace/blood', label: 'Blood', section: 'MeatSpace', aliases: ['meatspace-blood', 'blood'] },
  { id: 'nav.meatspace.genome', path: '/meatspace/genome', label: 'Genome', section: 'MeatSpace', aliases: ['meatspace-genome', 'genome'] },
  { id: 'nav.meatspace.lifestyle', path: '/meatspace/lifestyle', label: 'Lifestyle', section: 'MeatSpace', aliases: ['meatspace-lifestyle', 'lifestyle'] },
  { id: 'nav.meatspace.settings', path: '/meatspace/settings', label: 'Settings', section: 'MeatSpace', aliases: ['meatspace-settings'] },

  // ── Messages ──────────────────────────────────────────────────────────
  { id: 'nav.messages.inbox', path: '/messages/inbox', label: 'Inbox', section: 'Messages', aliases: ['messages'] },
  { id: 'nav.messages.drafts', path: '/messages/drafts', label: 'Drafts', section: 'Messages', aliases: ['drafts'] },
  { id: 'nav.messages.config', path: '/messages/config', label: 'Config', section: 'Messages', aliases: ['messages-config'] },
  { id: 'nav.messages.sync', path: '/messages/sync', label: 'Sync', section: 'Messages', aliases: ['messages-sync'] },

  // ── POST ──────────────────────────────────────────────────────────────
  { id: 'nav.post.launcher', path: '/post/launcher', label: 'Launcher', section: 'POST', aliases: ['post', 'post-launcher'] },
  { id: 'nav.post.config', path: '/post/config', label: 'Config', section: 'POST', aliases: ['post-config'] },
  { id: 'nav.post.history', path: '/post/history', label: 'History', section: 'POST', aliases: ['post-history'] },
  { id: 'nav.post.memory', path: '/post/memory', label: 'Memory', section: 'POST', aliases: ['post-memory'] },
  { id: 'nav.post.wordplay', path: '/post/wordplay', label: 'Wordplay', section: 'POST', aliases: ['post-wordplay'] },

  // ── Settings ──────────────────────────────────────────────────────────
  { id: 'nav.settings.backup', path: '/settings/backup', label: 'Backup', section: 'Settings', aliases: ['settings', 'backup'] },
  { id: 'nav.settings.database', path: '/settings/database', label: 'Database', section: 'Settings', aliases: ['settings-database', 'database'] },
  { id: 'nav.settings.image-gen', path: '/settings/image-gen', label: 'Image Gen', section: 'Settings', aliases: ['image-gen'] },
  { id: 'nav.settings.telegram', path: '/settings/telegram', label: 'Telegram', section: 'Settings', aliases: ['settings-telegram', 'telegram'] },
  { id: 'nav.settings.voice', path: '/settings/voice', label: 'Voice', section: 'Settings', aliases: ['settings-voice', 'voice'] },
  { id: 'nav.prompts', path: '/prompts', label: 'Prompts', section: 'Settings', aliases: ['prompts'] },
  { id: 'nav.providers', path: '/ai', label: 'Providers', section: 'Settings', aliases: ['providers', 'ai-providers'] },
  { id: 'nav.security', path: '/security', label: 'Security', section: 'Settings', aliases: ['security'] },
  { id: 'nav.uploads', path: '/uploads', label: 'Uploads', section: 'Settings', aliases: ['uploads'] },

  // ── Wiki ──────────────────────────────────────────────────────────────
  { id: 'nav.wiki.overview', path: '/wiki/overview', label: 'Overview', section: 'Wiki', aliases: ['wiki'] },
  { id: 'nav.wiki.browse', path: '/wiki/browse', label: 'Browse', section: 'Wiki', aliases: ['wiki-browse'] },
  { id: 'nav.wiki.graph', path: '/wiki/graph', label: 'Graph', section: 'Wiki', aliases: ['wiki-graph'] },
  { id: 'nav.wiki.log', path: '/wiki/log', label: 'Log', section: 'Wiki', aliases: ['wiki-log'] },
  { id: 'nav.wiki.search', path: '/wiki/search', label: 'Search', section: 'Wiki', aliases: ['wiki-search'] },
];

// Fail-fast: every entry must be syntactically well-formed. Catches typos at
// server boot instead of on first user interaction. The voice agent used to
// silently fail when NAV_PAGES and Layout.jsx drifted — this guard is why the
// manifest is the single source.
for (const cmd of NAV_COMMANDS) {
  if (!cmd.id || !cmd.path || !cmd.label || !cmd.section) {
    throw new Error(`navManifest: malformed entry ${JSON.stringify(cmd)}`);
  }
  if (!cmd.path.startsWith('/')) {
    throw new Error(`navManifest: path must start with / — got "${cmd.path}" for ${cmd.id}`);
  }
}
{
  const seen = new Set();
  for (const cmd of NAV_COMMANDS) {
    if (seen.has(cmd.id)) throw new Error(`navManifest: duplicate id ${cmd.id}`);
    seen.add(cmd.id);
  }
}

// Pre-compute { alias → path } for the voice agent. Alias collisions resolve
// to the first entry that declared them — order matters in NAV_COMMANDS.
const aliasToPath = {};
for (const cmd of NAV_COMMANDS) {
  for (const alias of (cmd.aliases || [])) {
    if (!aliasToPath[alias]) aliasToPath[alias] = cmd.path;
  }
}

export const getNavAliasMap = () => ({ ...aliasToPath });

const normalizeLabel = (s) => (s || '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?:;,"']+$/, '');

// Fuzzy nav resolver — shared by voice `ui_navigate` and the palette API.
// Returns { path, matched, command } or null. The matcher is forgiving:
// exact → user-input-starts-with-alias → alias-starts-with-input → trailing
// token → substring. This is the same tiered search the voice agent has used
// successfully; extracting it here means future refinements flow to both.
export const resolveNavCommand = (input) => {
  if (!input || typeof input !== 'string') return null;
  const norm = normalizeLabel(input).replace(/\s+/g, '-');
  if (!norm) return null;

  const aliases = Object.keys(aliasToPath);
  const tail = norm.split('-').filter(Boolean).pop();

  // Tiered alias match, ordered from strictest to loosest.
  const tiers = [
    (a) => a === norm,
    (a) => norm.startsWith(a) && a.length >= 3,
    (a) => a.startsWith(norm),
    (a) => norm.endsWith(`-${a}`) && a.length >= 3,
    (a) => norm.includes(a) && a.length >= 4,
    (a) => a.includes(norm),
    (a) => tail && tail !== norm && a === tail,
  ];

  let matched = null;
  for (const test of tiers) {
    matched = aliases.find(test);
    if (matched) break;
  }
  if (!matched) return null;

  const path = aliasToPath[matched];
  const command = NAV_COMMANDS.find((c) => c.path === path && (c.aliases || []).includes(matched))
    || NAV_COMMANDS.find((c) => c.path === path);
  return { path, matched, command };
};
