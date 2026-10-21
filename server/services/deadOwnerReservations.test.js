import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import {
  cliRunRecordEnded, mindRecordHasNoActiveTurn, reconcileDeadOwnerReservations,
} from './deadOwnerReservations.js';

const roots = [];
const DEAD_PID = 2147483646;
const gate = () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'dead-owner-reservations-'));
  roots.push(root);
  return { root, admission: createMaintenanceAdmission(root) };
};
const readOps = (admission) => JSON.parse(fs.readFileSync(join(admission.directory, 'state.json'), 'utf8')).operations;
const rewritePid = (admission, id, pid) => {
  const file = join(admission.directory, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.operations.find(op => op.id === id).pid = pid;
  fs.writeFileSync(file, JSON.stringify(state));
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('reconcileDeadOwnerReservations', () => {
  const reconcile = (admission, extra = {}) => reconcileDeadOwnerReservations({
    admission,
    pidAlive: (pid) => pid === process.pid,
    cliRunEnded: () => false,
    mindTurnIdle: () => false,
    ...extra,
  });

  it('marks a dead-owner settled publication unsettled so receipt recovery can drain it, and leaves a live owner', () => {
    const { admission } = gate();
    const dead = admission.admit('settlement', 'Output publication');
    const live = admission.admit('settlement', 'Output publication');
    rewritePid(admission, dead.id, DEAD_PID);
    const before = readOps(admission).find(op => op.id === dead.id);
    const hold = admission.begin({ reason: 'Inspect refused publication', owner: 'Operator' }).hold;
    const receipt = { disposition: 'operator-reconciled' };
    const publish = vi.fn(() => receipt);
    const replay = vi.fn(() => receipt);
    // Settled residue is invisible to the receipt path. Skipping the stamp leaves this refusal in place.
    expect(() => admission.reconcilePublicationRefusal({ hold, expected: before, publish, replay })).toThrow(/uncertain publication/);
    expect(publish).not.toHaveBeenCalled();

    expect(reconcile(admission)).toMatchObject({ marked: 1, released: 0 });
    const stamped = readOps(admission).find(op => op.id === dead.id);
    expect(stamped).toMatchObject({ unsettled: true, pid: DEAD_PID, resource: 'Output publication' });
    expect(stamped.uncertaintyStamp).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readOps(admission).find(op => op.id === live.id).unsettled).toBeUndefined();

    expect(admission.reconcilePublicationRefusal({ hold, expected: stamped, publish, replay })).toBe(receipt);
    expect(publish).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
    expect(readOps(admission).some(op => op.id === dead.id)).toBe(false);
    expect(readOps(admission).some(op => op.id === live.id)).toBe(true);
  });

  it('does not rotate an uncertainty stamp or stamp a non-publication settlement', () => {
    const { admission } = gate();
    const stamped = admission.admit('settlement', 'Output publication');
    stamped.markUnsettled();
    const other = admission.admit('settlement', 'Saving');
    rewritePid(admission, stamped.id, DEAD_PID);
    rewritePid(admission, other.id, DEAD_PID);
    const stamp = readOps(admission).find(op => op.id === stamped.id).uncertaintyStamp;
    expect(reconcile(admission)).toEqual({ marked: 0, released: 0 });
    expect(readOps(admission).find(op => op.id === stamped.id).uncertaintyStamp).toBe(stamp);
    expect(readOps(admission).find(op => op.id === other.id).unsettled).toBeUndefined();
  });

  it('releases only the dead-owner kinds whose owning record proves completion', () => {
    const { admission } = gate();
    const ended = admission.admit('cli-run', 'fixture-run-ended');
    const open = admission.admit('cli-run', 'fixture-run-open');
    const liveRun = admission.admit('cli-run', 'fixture-run-live');
    const idleTurn = admission.admit('mind-turn', 'persistent-mind');
    const provider = admission.admit('provider', 'fixture-source');
    const media = admission.admit('media', 'fixture-render');
    for (const op of [ended, open, idleTurn, provider, media]) rewritePid(admission, op.id, DEAD_PID);

    expect(reconcile(admission, {
      cliRunEnded: (runId) => runId === 'fixture-run-ended',
      mindTurnIdle: () => true,
    })).toEqual({ marked: 0, released: 2 });
    const resources = admission.operations().map(op => op.resource).sort();
    expect(resources).toEqual(['fixture-render', 'fixture-run-live', 'fixture-run-open', 'fixture-source']);
    expect(admission.operations().find(op => op.id === liveRun.id)).toMatchObject({
      resource: 'fixture-run-live',
      pid: process.pid,
    });
  });

  it('keeps a dead mind-turn while a turn is still active, and an unsettled cli-run even after it ended', () => {
    const { admission } = gate();
    const turn = admission.admit('mind-turn', 'persistent-mind');
    const run = admission.admit('cli-run', 'fixture-run-ended');
    run.markUnsettled();
    rewritePid(admission, turn.id, DEAD_PID);
    rewritePid(admission, run.id, DEAD_PID);
    expect(reconcile(admission, {
      cliRunEnded: () => true,
      mindTurnIdle: () => false,
    })).toEqual({ marked: 0, released: 0 });
    expect(admission.operations().map(op => op.resource).sort()).toEqual(['fixture-run-ended', 'persistent-mind']);
  });

  it('skips quietly when the journal needs recovery', () => {
    const { admission } = gate();
    admission.admit('settlement', 'Output publication');
    fs.writeFileSync(join(admission.directory, 'state.json'), '{not json');
    expect(reconcile(admission)).toEqual({ marked: 0, released: 0 });
  });
});

describe('owning-record proofs', () => {
  it('treats a non-empty end time as a finished cli run and ignores escapes', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'dead-owner-runs-'));
    roots.push(root);
    const write = (id, endTime) => {
      fs.mkdirSync(join(root, id));
      fs.writeFileSync(join(root, id, 'metadata.json'), JSON.stringify({ endTime }));
    };
    write('fixture-run-ended', '2026-01-01T00:00:00.000Z');
    write('fixture-run-open', null);
    expect(cliRunRecordEnded('fixture-run-ended', root)).toBe(true);
    expect(cliRunRecordEnded('fixture-run-open', root)).toBe(false);
    expect(cliRunRecordEnded('fixture-run-missing', root)).toBe(false);
    expect(cliRunRecordEnded('../fixture-run-ended', root)).toBe(false);
    expect(cliRunRecordEnded('', root)).toBe(false);
  });

  it('requires a mind object with no active turn', () => {
    expect(mindRecordHasNoActiveTurn(null)).toBe(false);
    expect(mindRecordHasNoActiveTurn({})).toBe(false);
    expect(mindRecordHasNoActiveTurn({ persistentMind: [] })).toBe(false);
    expect(mindRecordHasNoActiveTurn({ persistentMind: {} })).toBe(true);
    expect(mindRecordHasNoActiveTurn({ persistentMind: { activeTurn: null } })).toBe(true);
    expect(mindRecordHasNoActiveTurn({ persistentMind: { activeTurn: { id: 'fixture-turn' } } })).toBe(false);
  });
});
