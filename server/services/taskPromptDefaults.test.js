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
