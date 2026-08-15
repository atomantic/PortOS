import { describe, it, expect } from 'vitest';
import { execFileSync } from '../../lib/childProcess.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Guard for the render-target resolver contract (#3231 Phase 2): every
// creative surface resolves its image backend through
// `resolveRenderTargetConfig` (which layers the per-surface
// `settings.renderDefaults` pin and threads its imageModel into the provider
// params) — NOT by calling `resolveCloudProviderConfig` directly, which
// silently drops both. This test fails when a new call site reaches for the
// low-level resolver, forcing the author to either register a render target
// or consciously add the file to the allowlist below.
//
// Scoped to git-tracked files so editor backups / untracked scratch never
// flake it.

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Files allowed to call resolveCloudProviderConfig directly:
// - cloudProviderConfig.js — defines it (and resolveRenderTargetConfig wraps it).
// - routes/imageGen.js + services/imageGen/index.js — the user-facing
//   dispatcher pair: the request carries an explicit mode + cloudModel, so
//   there is no render target to consult (the Image Gen page IS the manual
//   surface).
// - services/imageGen/prepareParams.js — the extracted pre-dispatch half of
//   routes/imageGen.js, on the same request. It does NOT resolve a backend
//   (`mode` is already resolved above it, through resolveRenderTargetConfig on
//   the music-video path); it only reads `enabled` so a disabled provider is
//   rejected BEFORE uploads are staged to PATHS.imageRefs. Rejecting later, in
//   the route, strands those staged copies — the route's res.on('close') sweep
//   covers only multer temps.
const ALLOWED = new Set([
  'services/imageGen/cloudProviderConfig.js',
  'routes/imageGen.js',
  'services/imageGen/index.js',
  'services/imageGen/prepareParams.js',
]);

describe('render-target resolver guard (#3231)', () => {
  it('no surface calls resolveCloudProviderConfig outside the dispatcher allowlist', () => {
    const tracked = execFileSync('git', ['ls-files', '*.js'], { cwd: SERVER_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.endsWith('.test.js'));
    const offenders = tracked.filter((rel) => {
      if (ALLOWED.has(rel)) return false;
      const src = readFileSync(join(SERVER_ROOT, rel), 'utf8');
      return src.includes('resolveCloudProviderConfig(');
    });
    expect(offenders, `These files call resolveCloudProviderConfig directly — route them through resolveRenderTargetConfig (register a RENDER_TARGET in lib/renderTargets.js) or consciously extend the allowlist: ${offenders.join(', ')}`).toEqual([]);
  });
});
