/**
 * Parity guard for the auth-boundary documentation.
 *
 * AGENTS.md's Security Model is treated as ground truth by audits, so its Auth
 * bullet must name every path in ALWAYS_PUBLIC_API_PATHS. It also guards against
 * docs citing the retired bare `PUBLIC_API_PATHS` identifier.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ALWAYS_PUBLIC_API_PATHS } from '../../../lib/apiAccessPolicy.js';
import { readText, REPO_ROOT as ROOT } from '../../../../scripts/lib/guardCorpus.js';

describe('auth-exempt path documentation', () => {
  it('AGENTS.md Auth bullet names every always-public path and its source file', () => {
    const bullet = readText(join(ROOT, 'AGENTS.md'))
      .split('\n')
      .find((line) => line.startsWith('- **Auth**'));
    expect(bullet).toBeDefined();
    expect(bullet).toContain('server/lib/apiAccessPolicy.js');
    for (const path of ALWAYS_PUBLIC_API_PATHS) expect(bullet).toContain(`\`${path}\``);
  });

  it('no tracked file cites the retired bare PUBLIC_API_PATHS identifier', () => {
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        ['grep', '-nw', 'PUBLIC_API_PATHS', '--', ':!server/test/guards/repo/auth-public-paths-doc.test.js'],
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      if (err.status !== 1) throw err; // 1 = no matches
    }
    expect(hits).toBe('');
  });
});
