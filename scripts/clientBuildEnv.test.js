/**
 * Guard for the client bundle's compile-time NODE_ENV.
 *
 * PortOS builds the client from inside a PM2 tree that exports
 * NODE_ENV=development, and Vite inherits that rather than defaulting a build to
 * production. The result shipped for real: the deployed `dist/` carried the
 * DEVELOPMENT react/react-dom — 488 kB of vendor-react instead of 284 kB, plus
 * StrictMode double-invoking every mount effect in production (one visit to
 * /music persisted two empty draft tracks).
 *
 * Nothing near the build fails when this regresses — the bundle is merely
 * bigger, slower, and double-firing — so the invariant is pinned here. Lives in
 * `scripts/` and reads vite.config.js as TEXT for the same reason
 * dev-proxy-drift.test.js does: importing it would pull in the client's
 * dependencies, which the server's node runner does not have.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Dependency-free by construction — see the module's own header.
import { resolveBundleNodeEnv } from '../client/vite.buildEnv.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const viteConfig = readFileSync(join(REPO_ROOT, 'client', 'vite.config.js'), 'utf8');

describe('resolveBundleNodeEnv', () => {
  it('forces production for a build even when the environment says development', () => {
    // The actual PortOS case: PM2 exports NODE_ENV=development and `npm start`
    // (and the self-updater) build from inside that process tree.
    expect(resolveBundleNodeEnv('build', 'development')).toBe('production');
  });

  it('forces production for a build under any other inherited value', () => {
    expect(resolveBundleNodeEnv('build', undefined)).toBe('production');
    expect(resolveBundleNodeEnv('build', '')).toBe('production');
    expect(resolveBundleNodeEnv('build', 'test')).toBe('production');
    expect(resolveBundleNodeEnv('build', 'production')).toBe('production');
  });

  it('leaves the dev server on development', () => {
    // `vite serve` genuinely wants the dev builds — their warnings are the point.
    expect(resolveBundleNodeEnv('serve', 'development')).toBe('development');
    expect(resolveBundleNodeEnv('serve', undefined)).toBe('development');
  });
});

describe('client/vite.config.js', () => {
  it('applies the resolved value to process.env.NODE_ENV', () => {
    // A helper nothing assigns from is a helper that fixes nothing: Vite reads
    // process.env.NODE_ENV (not our return value) to derive isProduction, the
    // `process.env.NODE_ENV` define, and the plugin's JSX runtime.
    expect(viteConfig).toMatch(
      /process\.env\.NODE_ENV\s*=\s*resolveBundleNodeEnv\(\s*command\s*,\s*process\.env\.NODE_ENV\s*\)/,
    );
    expect(viteConfig).toContain("from './vite.buildEnv.js'");
  });

  it('assigns before loadEnv, so the config file wins over the inherited value', () => {
    // Vite loads this config file BEFORE it derives isProduction — but only the
    // statements that actually run first inside the factory beat the rest of the
    // config. Pin the ordering rather than trusting the diff to preserve it.
    const assignAt = viteConfig.indexOf('process.env.NODE_ENV = resolveBundleNodeEnv(');
    const loadEnvAt = viteConfig.indexOf('loadEnv(');
    expect(assignAt).toBeGreaterThan(-1);
    expect(loadEnvAt).toBeGreaterThan(-1);
    expect(assignAt).toBeLessThan(loadEnvAt);
  });
});
