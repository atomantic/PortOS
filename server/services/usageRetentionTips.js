import { homedir } from 'os';
import { join, sep } from 'path';
import { readJSONFile } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings, updateSettingsWith } from './settings.js';

// Machine-local: each install reads its own CLI config, so a dismissal never
// speaks for another machine.
const DISMISSED_KEY = 'dismissedUsageTips';

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const displayPath = (path) => {
  const home = homedir();
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
};

// Only settings verified in each CLI's official docs. Codex
// (~/.codex/sessions), Grok (~/.grok/sessions) and Antigravity
// (~/.gemini/antigravity-cli/conversations) keep the session files PortOS
// reads until the user deletes them; their documented history caps
// (Codex history.max_bytes, Antigravity historySize) cover prompt recall only.
const TIPS = [
  {
    id: 'claude-cleanup-period',
    label: 'Keep Claude Code sessions',
    text: 'Claude Code deletes session transcripts after 30 days, so older usage and sessions can no longer be read.',
    path: () => join(claudeHome(), 'settings.json'),
    snippet: '"cleanupPeriodDays": 36500',
    docsUrl: 'https://code.claude.com/docs/en/settings-reference#cleanupperioddays',
    // Anything of ten years or more already keeps the history this tip asks for.
    isApplied: (settings) => Number(settings?.cleanupPeriodDays) >= 3650,
  },
];

const describeTip = ({ id, label, text, path, snippet, docsUrl }) => ({ id, label, text, file: displayPath(path()), snippet, docsUrl });

/** Tips not yet applied in the CLI's own config and not dismissed by the user. */
export async function getUsageRetentionTips() {
  const settings = await getSettings();
  const dismissed = new Set(Array.isArray(settings?.[DISMISSED_KEY]) ? settings[DISMISSED_KEY] : []);
  const open = await Promise.all(TIPS.map(async (tip) => {
    if (dismissed.has(tip.id)) return null;
    const config = await readJSONFile(tip.path(), null, { logError: false });
    return tip.isApplied(config) ? null : describeTip(tip);
  }));
  return open.filter(Boolean);
}

export async function dismissUsageRetentionTip(id) {
  if (!TIPS.some((tip) => tip.id === id)) throw new ServerError(`Unknown usage tip: ${id}`, { status: 404 });
  await updateSettingsWith((current) => {
    const list = Array.isArray(current[DISMISSED_KEY]) ? current[DISMISSED_KEY] : [];
    return list.includes(id) ? current : { ...current, [DISMISSED_KEY]: [...list, id] };
  });
  return getUsageRetentionTips();
}
