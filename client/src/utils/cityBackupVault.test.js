import { describe, it, expect } from 'vitest';
import {
  VAULT,
  vaultHealth,
  vaultColor,
  vaultIsAlerting,
  vaultStatusLabel,
  computeBackupVault,
} from './cityBackupVault';

const NOW = new Date('2026-06-03T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 60 * 60 * 1000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

describe('vaultHealth', () => {
  it('returns "never" when there is no state, no lastRun, or status never', () => {
    expect(vaultHealth(undefined, NOW)).toBe('never');
    expect(vaultHealth({}, NOW)).toBe('never');
    expect(vaultHealth({ status: 'never', lastRun: null }, NOW)).toBe('never');
  });

  it('returns "never" when lastRun is an unparseable timestamp', () => {
    expect(vaultHealth({ status: 'ok', lastRun: 'not-a-date' }, NOW)).toBe('never');
  });

  it('returns "ok" for a snapshot inside the fresh window', () => {
    expect(vaultHealth({ status: 'ok', lastRun: hoursAgo(2) }, NOW)).toBe('ok');
  });

  it('ages to "aging" between the fresh and stale thresholds', () => {
    expect(vaultHealth({ status: 'ok', lastRun: daysAgo(2) }, NOW)).toBe('aging');
  });

  it('goes "stale" once past the stale threshold', () => {
    expect(vaultHealth({ status: 'ok', lastRun: daysAgo(5) }, NOW)).toBe('stale');
  });

  it('treats the thresholds as inclusive lower bounds', () => {
    expect(vaultHealth({ status: 'ok', lastRun: new Date(NOW - VAULT.freshMs).toISOString() }, NOW)).toBe('aging');
    expect(vaultHealth({ status: 'ok', lastRun: new Date(NOW - VAULT.staleMs).toISOString() }, NOW)).toBe('stale');
  });

  it('reports "error" when the last run failed, regardless of age', () => {
    expect(vaultHealth({ status: 'error', lastRun: hoursAgo(1) }, NOW)).toBe('error');
  });

  it('reports "running" when a backup is in flight, overriding everything', () => {
    expect(vaultHealth({ status: 'error', lastRun: daysAgo(9), running: true }, NOW)).toBe('running');
  });
});

describe('vaultColor', () => {
  it('maps each health to a distinct token; stale and error share the error red', () => {
    expect(vaultColor('ok')).toBe('#22c55e');
    expect(vaultColor('aging')).toBe('#f59e0b');
    expect(vaultColor('stale')).toBe('#ef4444');
    expect(vaultColor('error')).toBe('#ef4444');
    expect(vaultColor('running')).toBe('#3b82f6');
    expect(vaultColor('never')).toBe('#64748b');
  });

  it('falls back to the never color for an unknown health', () => {
    expect(vaultColor('bogus')).toBe(vaultColor('never'));
  });
});

describe('vaultIsAlerting', () => {
  it('alerts only on stale or error', () => {
    expect(vaultIsAlerting('stale')).toBe(true);
    expect(vaultIsAlerting('error')).toBe(true);
    expect(vaultIsAlerting('ok')).toBe(false);
    expect(vaultIsAlerting('aging')).toBe(false);
    expect(vaultIsAlerting('running')).toBe(false);
    expect(vaultIsAlerting('never')).toBe(false);
  });
});

describe('vaultStatusLabel', () => {
  it('gives a label for every health and a default for unknown', () => {
    expect(vaultStatusLabel('running')).toBe('BACKING UP');
    expect(vaultStatusLabel('ok')).toBe('PROTECTED');
    expect(vaultStatusLabel('aging')).toBe('AGING');
    expect(vaultStatusLabel('stale')).toBe('STALE');
    expect(vaultStatusLabel('error')).toBe('FAILED');
    expect(vaultStatusLabel('never')).toBe('NO BACKUP');
    expect(vaultStatusLabel('bogus')).toBe('NO BACKUP');
  });
});

describe('computeBackupVault', () => {
  it('carries the fixed geometry through unchanged', () => {
    const vm = computeBackupVault({ status: 'ok', lastRun: hoursAgo(1) }, NOW);
    expect(vm.position).toEqual(VAULT.position);
    expect(vm.width).toBe(VAULT.width);
    expect(vm.height).toBe(VAULT.height);
  });

  it('a fresh backup is calm, protected, and not alerting', () => {
    const vm = computeBackupVault({ status: 'ok', lastRun: hoursAgo(1) }, NOW);
    expect(vm.health).toBe('ok');
    expect(vm.alerting).toBe(false);
    expect(vm.running).toBe(false);
    expect(vm.statusLabel).toBe('PROTECTED');
    expect(vm.intensity).toBe(0.5);
  });

  it('a stale backup alerts and burns brighter', () => {
    const vm = computeBackupVault({ status: 'ok', lastRun: daysAgo(5) }, NOW);
    expect(vm.health).toBe('stale');
    expect(vm.alerting).toBe(true);
    expect(vm.intensity).toBe(0.85);
    expect(vm.color).toBe('#ef4444');
  });

  it('a running backup is the brightest and exposes running=true', () => {
    const vm = computeBackupVault({ status: 'ok', lastRun: hoursAgo(1), running: true }, NOW);
    expect(vm.health).toBe('running');
    expect(vm.running).toBe(true);
    expect(vm.intensity).toBe(1);
  });

  it('passes lastRun through for the time-since label, null when never', () => {
    expect(computeBackupVault({ status: 'ok', lastRun: hoursAgo(3) }, NOW).lastRun).toBe(hoursAgo(3));
    expect(computeBackupVault({ status: 'never' }, NOW).lastRun).toBeNull();
  });
});
