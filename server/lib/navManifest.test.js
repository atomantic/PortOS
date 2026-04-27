import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_COMMANDS, getNavAliasMap, resolveNavCommand } from './navManifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Maps URL prefix → file holding the page's TABS constant. Each page validates
// the :tab param against its own TABS list, so the nav manifest must agree.
const TABBED_PAGES = [
  { prefix: '/brain', constantsFile: 'client/src/components/brain/constants.js' },
  { prefix: '/cos', constantsFile: 'client/src/components/cos/constants.js' },
  { prefix: '/digital-twin', constantsFile: 'client/src/components/digital-twin/constants.js' },
  { prefix: '/meatspace', constantsFile: 'client/src/components/meatspace/constants.js' },
];

// Extract `id: '<value>'` from the first `export const TABS = [ ... ];` block.
function extractTabIds(constantsPath) {
  const src = fs.readFileSync(constantsPath, 'utf8');
  const block = src.match(/export const TABS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error(`No TABS array found in ${constantsPath}`);
  return [...block[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('navManifest — shape invariants', () => {
  it('every command has id, path, label, section', () => {
    for (const cmd of NAV_COMMANDS) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.path).toMatch(/^\//);
      expect(cmd.label).toBeTruthy();
      expect(cmd.section).toBeTruthy();
    }
  });

  it('ids are unique', () => {
    const ids = NAV_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveNavCommand — fuzzy matching', () => {
  it('resolves exact alias', () => {
    expect(resolveNavCommand('dashboard')?.path).toBe('/');
    expect(resolveNavCommand('tasks')?.path).toBe('/cos/tasks');
    expect(resolveNavCommand('goals')?.path).toBe('/goals/list');
  });

  it('resolves multi-word voice phrasings that end on a known page', () => {
    // "take me to the tasks page" → normalized "take-me-to-the-tasks-page"
    // → the resolver's "key contained in norm" tier picks up "tasks" via the
    // trailing token fallback (tail = "page" doesn't match, then substring
    // "tasks" is present in the normalized input).
    expect(resolveNavCommand('chief of staff tasks')?.path).toBe('/cos/tasks');
    expect(resolveNavCommand('cos tasks')?.path).toBe('/cos/tasks');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(resolveNavCommand('BRAIN.')?.path).toBe('/brain/inbox');
    expect(resolveNavCommand('Review Hub!')?.path).toBe('/review');
  });

  it('returns null for unknown pages', () => {
    expect(resolveNavCommand('this-page-does-not-exist')).toBeNull();
    expect(resolveNavCommand('')).toBeNull();
    expect(resolveNavCommand(null)).toBeNull();
  });

  it('surfaces the matched alias for logging/telemetry', () => {
    const hit = resolveNavCommand('gsd');
    expect(hit?.matched).toBe('gsd');
    expect(hit?.path).toBe('/cos/gsd');
  });
});

describe('nav contract — tabbed pages match their TABS constants', () => {
  for (const { prefix, constantsFile } of TABBED_PAGES) {
    describe(prefix, () => {
      // Read inside it() bodies (not at describe time) so a moved/renamed
      // constants file surfaces as a focused test failure rather than
      // aborting the entire suite during Vitest's collection phase.
      const navEntries = NAV_COMMANDS.filter((c) => c.path.startsWith(`${prefix}/`));
      const navTabs = navEntries.map((c) => ({ tab: c.path.slice(prefix.length + 1), command: c }));

      it('every nav manifest tab resolves to a real TAB id', () => {
        const tabIdSet = new Set(extractTabIds(path.join(REPO_ROOT, constantsFile)));
        const orphans = navTabs
          .filter(({ tab }) => !tabIdSet.has(tab))
          .map(({ command, tab }) => `${command.id} (${command.path}) → unknown tab "${tab}"`);
        expect(orphans).toEqual([]);
      });

      it('every TAB id is reachable via the nav manifest', () => {
        const tabIds = extractTabIds(path.join(REPO_ROOT, constantsFile));
        const navTabSet = new Set(navTabs.map((t) => t.tab));
        const missing = tabIds.filter((id) => !navTabSet.has(id));
        expect(missing).toEqual([]);
      });
    });
  }
});

describe('getNavAliasMap — voice-agent compatibility', () => {
  it('exposes every alias as a flat path map', () => {
    const map = getNavAliasMap();
    expect(map.dashboard).toBe('/');
    expect(map.tasks).toBe('/cos/tasks');
    expect(map.twin).toBe('/digital-twin/overview');
  });

  it('has no alias collisions (first-declared-wins guarantees deterministic resolution if any are introduced)', () => {
    const counts = {};
    for (const cmd of NAV_COMMANDS) {
      for (const a of (cmd.aliases || [])) counts[a] = (counts[a] || 0) + 1;
    }
    const collisions = Object.entries(counts).filter(([, n]) => n > 1);
    expect(collisions).toEqual([]);
  });
});
