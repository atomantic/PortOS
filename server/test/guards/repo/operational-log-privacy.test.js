/**
 * Pins the privacy contract from #17561: operational console lines in these
 * modules must not interpolate personal identifiers, user-authored titles,
 * upload filenames, host paths, OAuth client IDs or peer addresses.
 * Source-level on purpose: the call sites sit deep inside handlers that need
 * live network/Telegram/OAuth state to execute.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const FORBIDDEN = {
  'server/services/socialAccounts.js': [/account\.username/],
  'server/services/review.js': [/\$\{title\}/, /\b(?:item|reopened|removed)\.title/],
  'server/routes/brainImport.js': [/originalname/],
  'server/services/telegramBridge.js': [/chatId/, /attachment\.filename/],
  'server/services/telegram.js': [/attachment\.filename/, /CHECKINS_FILE/],
  'server/services/googleOAuthAutoConfig.js': [/credentials\.clientId/],
  'server/services/instances.js': [/\$\{address\}/, /existing\.address/, /peer\.host\}/, /normalizedHost/, /peerBaseUrl/],
  'server/services/obsidian.js': [/vault\.name/, /removed\.name/, /\$\{path\}/, /fullPath/, /notePath/],
  'server/services/platformAccounts.js': [/credentials\.username/],
  'server/services/x.js': [/account\.username/],
  'server/services/agent/agentActionExecutor.js': [/credentials\.username/, /agentUsername/, /params\.message/, /params\.thought/, /\.substring\(/],
  'server/services/brainMemoryBridge.js': [/record\.name/, /record\.title/]
};

const consoleLines = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')
  .split('\n')
  .filter((l) => /\bconsole\s*\.\s*(log|warn|error)\s*\(/.test(l));

describe('operational logs omit personal and machine-identifying values', () => {
  for (const [file, patterns] of Object.entries(FORBIDDEN)) {
    it(file, () => {
      const lines = consoleLines(file);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const p of patterns) expect(line, `${p} in: ${line.trim()}`).not.toMatch(p);
      }
    });
  }
});
