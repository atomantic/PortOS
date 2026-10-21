import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { resolvePinnedNodeInterpreter } from '../server/lib/nodeInterpreterPin.js';

/**
 * The pinned interpreter decides which Node pm2 starts PortOS on, so a bad pin
 * must degrade to PATH's `node` instead of leaving pm2 unable to start the
 * server — the case is an nvm version removed after the Node panel pinned it.
 * The ecosystem file carries a CJS copy of the server rule; both are checked
 * against the same inputs here so they cannot drift.
 */
const require = createRequire(import.meta.url);
const configPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'ecosystem.config.cjs');

const loadInterpreters = () => {
  delete require.cache[require.resolve(configPath)];
  return [...new Set(require(configPath).apps.map((app) => app.interpreter))];
};

const original = process.env.PORTOS_NODE_INTERPRETER;
afterEach(() => {
  if (original === undefined) delete process.env.PORTOS_NODE_INTERPRETER;
  else process.env.PORTOS_NODE_INTERPRETER = original;
});

describe('pinned Node interpreter', () => {
  it('launches every PortOS app on an existing pinned node binary', () => {
    process.env.PORTOS_NODE_INTERPRETER = process.execPath;
    expect(loadInterpreters()).toEqual([process.execPath]);
    expect(resolvePinnedNodeInterpreter({ envPath: '/nonexistent/.env' })).toBe(process.execPath);
  });

  it.each([
    ['a removed version', path.join(path.dirname(process.execPath), 'missing', 'node')],
    ['a relative path', 'bin/node'],
    ['a binary that is not node', path.join(path.dirname(process.execPath), 'npm')],
  ])('falls back to PATH resolution for %s', (_label, candidate) => {
    process.env.PORTOS_NODE_INTERPRETER = candidate;
    expect(resolvePinnedNodeInterpreter({ envPath: '/nonexistent/.env' })).toBeNull();
    // The real .env may pin a usable binary on a developer machine; either way
    // the bad exported value never reaches pm2.
    expect(loadInterpreters()).not.toContain(candidate);
  });
});
