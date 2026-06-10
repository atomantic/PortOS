import { describe, it, expect, afterEach, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  isWithinRoot,
  isWithinAllowedRoots,
  ALLOWED_WORKSPACE_ROOTS,
  DEFAULT_WORKSPACE_ROOTS,
} from './workspaceRoots.js';

describe('isWithinRoot', () => {
  it('returns true when the path IS the root', () => {
    expect(isWithinRoot('/Users/alice', '/Users/alice')).toBe(true);
  });

  it('returns true for a descendant of the root', () => {
    expect(isWithinRoot('/Users/alice/repo', '/Users/alice')).toBe(true);
    expect(isWithinRoot('/Users/alice/repo/src/index.js', '/Users/alice')).toBe(true);
  });

  it('returns false for a path outside the root', () => {
    expect(isWithinRoot('/etc/passwd', '/Users/alice')).toBe(false);
    expect(isWithinRoot('/Users/bob', '/Users/alice')).toBe(false);
  });

  it('is separator-safe — a sibling that shares a name prefix is NOT contained', () => {
    // /Users/alice-evil starts with "/Users/alice" as a string but is not under it.
    expect(isWithinRoot('/Users/alice-evil/repo', '/Users/alice')).toBe(false);
  });

  it('does not treat a parent as contained', () => {
    expect(isWithinRoot('/Users', '/Users/alice')).toBe(false);
  });
});

describe('isWithinAllowedRoots', () => {
  it('accepts a path under a default root (home dir)', () => {
    expect(isWithinAllowedRoots(join(homedir(), 'projects', 'foo'))).toBe(true);
  });

  it('rejects a path outside every allowed root', () => {
    // /etc is not in DEFAULT_WORKSPACE_ROOTS and (in tests) PORTOS_WORKSPACE_ROOTS is unset.
    expect(isWithinAllowedRoots('/etc/shadow')).toBe(false);
  });
});

describe('ALLOWED_WORKSPACE_ROOTS', () => {
  it('includes every default root', () => {
    // Defaults are symlink-resolved, so compare on length/non-empty rather than
    // exact strings (e.g. /tmp -> /private/tmp on macOS).
    expect(ALLOWED_WORKSPACE_ROOTS.length).toBeGreaterThanOrEqual(DEFAULT_WORKSPACE_ROOTS.length);
    expect(ALLOWED_WORKSPACE_ROOTS.every(r => typeof r === 'string' && r.length > 0)).toBe(true);
  });
});

// PORTOS_WORKSPACE_ROOTS is read once at module load, so these re-import a fresh
// copy of the module under a stubbed env to exercise the opt-in gate (the actual
// subject of issue #1089) in both states.
describe('PORTOS_WORKSPACE_ROOTS opt-in gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('WORKSPACE_ROOTS_CONFIGURED is false when the env var is unset', async () => {
    vi.stubEnv('PORTOS_WORKSPACE_ROOTS', '');
    vi.resetModules();
    const mod = await import('./workspaceRoots.js');
    expect(mod.WORKSPACE_ROOTS_CONFIGURED).toBe(false);
    expect(mod.EXTRA_WORKSPACE_ROOTS).toEqual([]);
  });

  it('parses colon-separated roots, trimming and dropping empties', async () => {
    vi.stubEnv('PORTOS_WORKSPACE_ROOTS', ' /srv/repos : : /data/projects ');
    vi.resetModules();
    const mod = await import('./workspaceRoots.js');
    expect(mod.WORKSPACE_ROOTS_CONFIGURED).toBe(true);
    expect(mod.EXTRA_WORKSPACE_ROOTS).toEqual(['/srv/repos', '/data/projects']);
  });

  it('folds the configured roots into the allow-list so paths under them pass', async () => {
    vi.stubEnv('PORTOS_WORKSPACE_ROOTS', '/srv/repos');
    vi.resetModules();
    const mod = await import('./workspaceRoots.js');
    // /srv/repos likely does not exist on the test host, so the root falls back
    // to its resolved (non-realpath) form — containment still matches descendants.
    expect(mod.isWithinAllowedRoots('/srv/repos/myapp')).toBe(true);
  });
});
