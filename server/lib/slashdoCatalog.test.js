/**
 * The shared bundled-workflow catalog (#3108) — the one declaration behind the
 * `POST /api/cos/tasks/slashdo` allowlist, the app-overview Agent Operations
 * buttons, and the CoS quick templates. These assertions lock the invariants
 * that keep those three surfaces from drifting apart again.
 */
import { describe, it, expect } from 'vitest';
import { readdir } from 'fs/promises';
import { join } from 'path';
import {
  SLASHDO_CATALOG,
  getSlashdoEntry,
  isLaunchableSlashdoCommand,
  slashdoCommandNames,
  templateEligibleEntries,
} from './slashdoCatalog.js';
import { isValidSlashdoCommand } from './slashdoInvocation.js';

describe('SLASHDO_CATALOG', () => {
  it('folds in every command the three former lists carried between them', () => {
    // `push`/`better-swift` came only from the route + panel; `plan-task`/
    // `depfree`/`scan` only from the quick templates. All ten are now launchable.
    expect(slashdoCommandNames().sort()).toEqual([
      'better', 'better-swift', 'depfree', 'next', 'plan-task',
      'push', 'release', 'replan', 'review', 'scan',
    ]);
  });

  it('declares each command exactly once, with a bare (path-safe) command name', () => {
    const names = SLASHDO_CATALOG.map(e => e.command);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of SLASHDO_CATALOG) {
      // The bare name is what gets persisted and joined into a path — never a
      // rendered `/do:x`, which would also be Claude-only.
      expect(isValidSlashdoCommand(entry.command)).toBe(true);
      expect(entry.label).toBe(`/do:${entry.command}`);
    }
  });

  it('gives every command one name, description, and full run shape', () => {
    for (const entry of SLASHDO_CATALOG) {
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.icon).toBeTruthy();
      expect(entry.context).toBeTruthy();
      // `reviewLoop: false` is the value the route carried and the templates
      // omitted — the divergence that made the same command behave differently
      // depending on which button queued it. Every key is spelled out because an
      // ABSENT settings key means "leave the toggle alone", not false.
      expect(entry.settings).toEqual({
        useWorktree: false, openPR: false, simplify: false, reviewLoop: false,
      });
    }
  });

  it('names only commands that actually ship in the bundled submodule', async () => {
    const dir = join(process.cwd(), '..', 'lib', 'slashdo', 'commands', 'do');
    const shipped = await readdir(dir).catch(() => null);
    // Submodule not checked out (a fresh clone without --recursive) — skip rather
    // than fail; `npm run install:all` initialises it.
    if (!shipped) return;
    const available = new Set(shipped.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')));
    for (const name of slashdoCommandNames()) {
      expect(available.has(name), `do/${name}.md missing from lib/slashdo`).toBe(true);
    }
  });

  it('marks exactly the quick-template commands as templateEligible', () => {
    expect(templateEligibleEntries().map(e => e.command).sort()).toEqual(
      ['better', 'depfree', 'next', 'plan-task', 'release', 'replan', 'review', 'scan']
    );
  });

  it('opens the pre-flight run drawer only for /do:next', () => {
    expect(SLASHDO_CATALOG.filter(e => e.configurable).map(e => e.command)).toEqual(['next']);
  });

  it('gates the Swift audit to Swift apps and hides the generic one there', () => {
    expect(getSlashdoEntry('better-swift').swiftOnly).toBe(true);
    expect(getSlashdoEntry('better').hideForSwift).toBe(true);
  });
});

describe('getSlashdoEntry / isLaunchableSlashdoCommand', () => {
  it('resolves a known command and rejects everything else', () => {
    expect(getSlashdoEntry('next').command).toBe('next');
    expect(isLaunchableSlashdoCommand('scan')).toBe(true);
    // Not launchable: real slashdo commands PortOS deliberately does not expose
    // as unattended CoS tasks, plus junk input.
    for (const bad of ['pr', 'rpr', 'update', 'invalid', '../../etc/passwd', '', null, undefined, 42, {}]) {
      expect(getSlashdoEntry(bad)).toBeNull();
      expect(isLaunchableSlashdoCommand(bad)).toBe(false);
    }
  });

  it('does not resolve inherited Object.prototype keys', () => {
    expect(getSlashdoEntry('constructor')).toBeNull();
    expect(getSlashdoEntry('toString')).toBeNull();
  });
});
