import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './425-eidoverse-controller-completed-delivery.js';

let rootDir;
let file;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'portos-migration-425-'));
  mkdirSync(join(rootDir, 'data', 'eidoverse'), { recursive: true });
  file = join(rootDir, 'data', 'eidoverse', 'controllers.json');
});
afterEach(() => rmSync(rootDir, { recursive: true, force: true }));
const write = (value) => writeFileSync(file, JSON.stringify(value));
const read = () => JSON.parse(readFileSync(file, 'utf8'));

describe('migration 425 — completed controller delivery history', () => {
  it('preserves legacy state/counters while leaving ambiguous delivery unknown, and reruns without writing', async () => {
    const legacy = { tick: 8, state: { pulses: 4 }, consecutiveFailures: 1, consecutiveDeliveryFailures: 2,
      lastOutcome: { effects: 1, delivered: 1, deliveryError: null }, recentEffects: [{ kind: 'say', summary: 'example pulse' }] };
    write({ schemaVersion: 1, installs: { beacon: legacy } });
    expect(await migration.up({ rootDir })).toEqual({ updated: 1, reason: 'upgraded' });
    expect(read()).toEqual({ schemaVersion: 2, installs: { beacon: { ...legacy, lastCompletedDelivery: null } } });
    const bytes = readFileSync(file, 'utf8');
    expect(await migration.up({ rootDir })).toEqual({ updated: 0, reason: 'already-current' });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('does not replace existing completed history when upgrading an unstamped store', async () => {
    const lastCompletedDelivery = { at: '2026-03-04T00:02:00.000Z', tick: 2, ok: false, delivered: 1, reason: 'partial refusal' };
    write({ installs: { beacon: { lastCompletedDelivery } } });
    await migration.up({ rootDir });
    expect(read()).toEqual({ schemaVersion: 2, installs: { beacon: { lastCompletedDelivery } } });
  });

  it('leaves missing, malformed and newer stores untouched rather than creating or downgrading them', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ reason: 'no-controller-store' });
    expect(existsSync(file)).toBe(false);
    for (const bytes of ['{broken', JSON.stringify({ installs: [] }), JSON.stringify({ schemaVersion: 3, installs: { beacon: { tick: 1 } } })]) {
      writeFileSync(file, bytes);
      await migration.up({ rootDir });
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    }
  });
});
