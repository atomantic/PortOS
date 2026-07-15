import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  DEFAULT_TASK_PROMPTS,
  PROMPT_VERSIONS,
  REFERENCE_WATCH_AUDITED_VERSION,
  PREVIOUS_DEFAULT_PROMPTS,
} from './taskPromptDefaults.js';
import { PORTOS_API_URL } from '../lib/ports.js';

// Hash snapshot of every exported prompt body and version. This pins the
// cross-install prompt-upgrade contract (see CLAUDE.md "Distribution model"):
// a refactor of the taskPromptDefaults/ split cannot silently alter a prompt
// byte, and an INTENTIONAL prompt change forces the author through this file —
// where the rule is: bump PROMPT_VERSIONS, append the outgoing default to
// PREVIOUS_DEFAULT_PROMPTS, then regenerate the snapshot:
//
//   cd server && node --input-type=module -e "
//   import('./services/taskPromptDefaults.js').then(async (m) => {
//     const { PORTOS_API_URL } = await import('./lib/ports.js');
//     const { createHash } = await import('crypto');
//     const norm = (s) => s.split(PORTOS_API_URL).join('{{PORTOS_API_URL}}');
//     const md5 = (s) => createHash('md5').update(norm(s), 'utf8').digest('hex');
//     const out = {
//       DEFAULT_TASK_PROMPTS: Object.fromEntries(Object.entries(m.DEFAULT_TASK_PROMPTS).map(([k, v]) => [k, md5(v)])),
//       PROMPT_VERSIONS: m.PROMPT_VERSIONS,
//       REFERENCE_WATCH_AUDITED_VERSION: m.REFERENCE_WATCH_AUDITED_VERSION,
//       PREVIOUS_DEFAULT_PROMPTS: Object.fromEntries(Object.entries(m.PREVIOUS_DEFAULT_PROMPTS).map(([k, a]) => [k, a.map(md5)])),
//     };
//     (await import('fs')).writeFileSync('services/taskPromptDefaults/integrity.snapshot.json', JSON.stringify(out, null, 2) + '\n');
//   })"
//
// PORTOS_API_URL is interpolated into one prompt at module load and varies by
// env (PORTOS_HOST/PORT), so it's normalized to a placeholder before hashing.
const SNAPSHOT = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'taskPromptDefaults', 'integrity.snapshot.json'),
  'utf8',
));

const normalize = (s) => s.split(PORTOS_API_URL).join('{{PORTOS_API_URL}}');
const md5 = (s) => createHash('md5').update(normalize(s), 'utf8').digest('hex');

describe('taskPromptDefaults integrity snapshot', () => {
  it('DEFAULT_TASK_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(DEFAULT_TASK_PROMPTS).map(([k, v]) => [k, md5(v)]),
    );
    expect(actual).toEqual(SNAPSHOT.DEFAULT_TASK_PROMPTS);
  });

  it('PROMPT_VERSIONS matches the snapshot', () => {
    expect(PROMPT_VERSIONS).toEqual(SNAPSHOT.PROMPT_VERSIONS);
  });

  it('REFERENCE_WATCH_AUDITED_VERSION matches the snapshot', () => {
    expect(REFERENCE_WATCH_AUDITED_VERSION).toBe(SNAPSHOT.REFERENCE_WATCH_AUDITED_VERSION);
  });

  it('PREVIOUS_DEFAULT_PROMPTS bodies match the snapshot hashes exactly', () => {
    const actual = Object.fromEntries(
      Object.entries(PREVIOUS_DEFAULT_PROMPTS).map(([k, arr]) => [k, arr.map(md5)]),
    );
    expect(actual).toEqual(SNAPSHOT.PREVIOUS_DEFAULT_PROMPTS);
  });

  // feature-ideas v10: rejected-ideas ledger consultation (issue #2621).
  // Pins the version-bump pairing — the prompt change ships WITH its version
  // bump and the outgoing v9 default preserved for cross-install auto-upgrade.
  it('feature-ideas v10 consults REJECTED.md and closed-unmerged PRs, preserving the v9 default', () => {
    const current = DEFAULT_TASK_PROMPTS['feature-ideas'];
    expect(current).toContain('REJECTED.md');
    expect(current).toContain('is:unmerged');
    expect(PROMPT_VERSIONS['feature-ideas']).toBe(10);

    const previous = PREVIOUS_DEFAULT_PROMPTS['feature-ideas'];
    const v9 = previous[previous.length - 1];
    // The outgoing v9 default lacked the rejected-ideas consultation and is
    // preserved verbatim so installs holding it are recognized and upgraded.
    expect(v9).not.toContain('REJECTED.md');
    expect(v9).toContain('.changelog/');
    expect(v9).not.toBe(current);
  });

  // NOTE: PROMPT_VERSIONS keys are SCHEDULE keys, not always prompt keys —
  // code-reviewer-a/b version a pipeline whose stages use the
  // code-reviewer-review / code-reviewer-implement prompt bodies — so there is
  // deliberately no "every versioned key has a prompt body" invariant here.
  it('every PREVIOUS_DEFAULT_PROMPTS key is a versioned prompt', () => {
    for (const key of Object.keys(PREVIOUS_DEFAULT_PROMPTS)) {
      expect(PROMPT_VERSIONS[key], `PROMPT_VERSIONS['${key}']`).toBeTypeOf('number');
    }
  });
});
