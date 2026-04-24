import { describe, it, expect } from 'vitest';
import { NAV_COMMANDS, getNavAliasMap, resolveNavCommand } from './navManifest.js';

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

describe('getNavAliasMap — voice-agent compatibility', () => {
  it('exposes every alias as a flat path map', () => {
    const map = getNavAliasMap();
    expect(map.dashboard).toBe('/');
    expect(map.tasks).toBe('/cos/tasks');
    expect(map.twin).toBe('/digital-twin/overview');
  });

  it('preserves first-declared alias on collision', () => {
    // "inbox" appears under Brain first and Messages second; Brain wins.
    expect(getNavAliasMap().inbox).toBe('/brain/inbox');
  });
});
