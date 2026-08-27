import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './305-refresh-quota-burn-audit-contract.js';
import { AUDIT_CONTRACT_HEADING, QUOTA_BURN_PROMPT_PRESETS } from '../../server/lib/quotaBurnPresets.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const preset = QUOTA_BURN_PROMPT_PRESETS[0];
const currentPrompt = preset.params.prompt;
const mission = currentPrompt.slice(0, currentPrompt.indexOf(AUDIT_CONTRACT_HEADING));

/**
 * A plausible OLD render: the shipped mission verbatim, plus a contract that
 * still carries the anchors every shipped revision has had but none of this
 * revision's wording. This is the shape migration 294 could not match — it is
 * neither the current render nor the one specific prior render 294 rebuilt.
 */
const staleContract = `${AUDIT_CONTRACT_HEADING}

1. **Pick a bounded slice and say so first.** Audit one area.
2. **File each finding.** \`gh issue create --title "..." --body-file "$BODY"\`.
   Suggested labels: \`ux\`, \`plan\`. Run \`gh label list\` first.
3. **Change no code.** The deliverable is the filed issues.
4. **Report at the end**: the slice you audited and each issue number.
`;
const stalePrompt = `${mission}${staleContract}`;

const config = (prompt) => ({
  families: { claude: { enabled: true, jobs: [{ id: 'job-1', jobType: 'agent-prompt', params: { appId: 'app-1', prompt } }] } },
});
const storedPrompt = (path) => readJson(path).families.claude.jobs[0].params.prompt;

describe('migration 305 — refresh quota-burn audit contract', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-305-'));
    mkdirSync(join(rootDir, 'data/cos'), { recursive: true });
    configPath = join(rootDir, 'data/cos/quota-burn.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('upgrades a stale shipped render that byte-for-byte matching would have skipped', async () => {
    writeJson(configPath, config(stalePrompt));
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(storedPrompt(configPath)).toBe(currentPrompt);
  });

  it('leaves a prompt whose How-to-run section the user rewrote', async () => {
    // Mission intact, procedure replaced — the anchors are gone, so this is the
    // user's own contract and refreshing it would delete their instructions.
    const custom = `${mission}${AUDIT_CONTRACT_HEADING}\n\nJust tell me what you find in chat. Do not file anything.\n`;
    writeJson(configPath, config(custom));
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(storedPrompt(configPath)).toBe(custom);
  });

  it('leaves a prompt whose mission the user rewrote', async () => {
    const custom = `# Audit the payments flow only\n\n${staleContract}`;
    writeJson(configPath, config(custom));
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(storedPrompt(configPath)).toBe(custom);
  });

  it('is a no-op on an already-current prompt and rewrites no file', async () => {
    writeJson(configPath, config(currentPrompt));
    const before = readFileSync(configPath, 'utf8');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('returns cleanly when the install has no quota-burn config', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0 });
  });
});
