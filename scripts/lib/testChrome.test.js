import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledChromium } from './testChrome.js';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function workspaceWithPlaywright(executable) {
  const dir = mkdtempSync(join(tmpdir(), 'testchrome-'));
  dirs.push(dir);
  const pkg = join(dir, 'node_modules', 'playwright-core');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core","main":"index.js"}');
  writeFileSync(join(pkg, 'index.js'), `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executable)} } };`);
  writeFileSync(join(dir, 'package.json'), '{}');
  return join(dir, 'package.json');
}

describe('bundledChromium', () => {
  it('finds playwright-core installed in a later workspace anchor', () => {
    const empty = mkdtempSync(join(tmpdir(), 'testchrome-empty-'));
    dirs.push(empty);
    writeFileSync(join(empty, 'package.json'), '{}');
    expect(bundledChromium([join(empty, 'package.json'), workspaceWithPlaywright('/x/chrome')])).toBe('/x/chrome');
  });

  it('returns null when no anchor resolves playwright-core', () => {
    const empty = mkdtempSync(join(tmpdir(), 'testchrome-empty-'));
    dirs.push(empty);
    writeFileSync(join(empty, 'package.json'), '{}');
    expect(bundledChromium([join(empty, 'package.json')])).toBeNull();
  });

  it('skips an anchor whose Chromium executable is missing for a later one that has it', () => {
    const present = join(mkdtempSync(join(tmpdir(), 'testchrome-bin-')), 'chrome');
    dirs.push(dirname(present));
    writeFileSync(present, '');
    const missingFirst = workspaceWithPlaywright(join(dirname(present), 'absent-chrome'));
    expect(bundledChromium([missingFirst, workspaceWithPlaywright(present)])).toBe(present);
  });

  it('returns the first resolved path when no anchor executable exists', () => {
    const first = workspaceWithPlaywright('/nope/a');
    expect(bundledChromium([first, workspaceWithPlaywright('/nope/b')])).toBe('/nope/a');
  });
});
