/**
 * Parity test for the repo-intake action keys: `REPO_INTAKE_KEYS` (server,
 * authoritative) ↔ `REPO_INTAKE_OPTIONS` (client, the rendered checkbox table).
 *
 * These are the wire contract. Drift is silent in both directions: a key added
 * server-side is simply never offered in either capture box, and a client-only
 * key is stripped by the Zod schema and ignored by `normalizeRepoIntake` with no
 * error anywhere. Unlike the repoUrl mirror this compares KEYS, not source
 * text — the client half legitimately carries labels, hints, and icons the
 * server has no business knowing about.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { REPO_INTAKE_KEYS } from './repoIntakeActions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(__dirname, '../../client/src/components/brain/RepoIntakeOptions.jsx');

// The client table is a .jsx module importing lucide-react, so a server-env
// suite can't import it (see the CI note in AGENTS.md about server tests pulling
// client deps). Read the `key:` entries out of the REPO_INTAKE_OPTIONS literal.
const clientKeys = () => {
  const src = readFileSync(CLIENT_PATH, 'utf8');
  const table = src.match(/REPO_INTAKE_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!table) return null;
  return [...table[1].matchAll(/^\s*key:\s*'([^']+)'/gm)].map(m => m[1]);
};

describe('repoIntake action-key parity (server ↔ client)', () => {
  it('the client table is parseable — a rename must fail here, not silently pass', () => {
    expect(clientKeys(), `Could not find REPO_INTAKE_OPTIONS in ${CLIENT_PATH}`).not.toBeNull();
    expect(clientKeys().length).toBeGreaterThan(0);
  });

  it('offers exactly the actions the server accepts, in the same order', () => {
    expect(clientKeys()).toEqual([...REPO_INTAKE_KEYS]);
  });
});
