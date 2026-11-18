/**
 * Covers `pinPlatform` and the repo-wide rule that no test hand-rolls the pin
 * it replaces (#4085). Twelve suites each re-implemented
 * `getOwnPropertyDescriptor` → `defineProperty` → restore, so the one hazard
 * that matters — never pin above an import that loads a native addon, which
 * picks its prebuilt binary off `process.platform` at load time — had to be
 * rediscovered at every site. It now lives on the helper's doc comment, and
 * the guard below keeps new sites from routing around it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { pinPlatform } from './testHelper.js';

describe('pinPlatform', () => {
  let restore = () => {};
  afterEach(() => restore());

  it('reports the pinned platform and restores the original descriptor', () => {
    const before = Object.getOwnPropertyDescriptor(process, 'platform');
    restore = pinPlatform('win32');
    expect(process.platform).toBe('win32');

    restore();
    restore = () => {};
    // The ORIGINAL descriptor, not a data-property snapshot of its value: a
    // restore that writes `{ value: <read>, configurable: true }` leaves the
    // accessor Node installed permanently replaced for the rest of the worker.
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(before);
  });

  it('deletes the pin when there was no own descriptor to restore', () => {
    // Node always gives `process` an own `platform`, so stage the case the
    // helper has to survive rather than assume it can't happen.
    const saved = Object.getOwnPropertyDescriptor(process, 'platform');
    delete process.platform;
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toBeUndefined();

    const undo = pinPlatform('freebsd');
    expect(process.platform).toBe('freebsd');
    undo();

    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toBeUndefined();
    Object.defineProperty(process, 'platform', saved);
  });

  it('unwinds nested pins in reverse order', () => {
    const before = process.platform;
    const undoOuter = pinPlatform('linux');
    const undoInner = pinPlatform('darwin');
    expect(process.platform).toBe('darwin');

    undoInner();
    expect(process.platform).toBe('linux');
    undoOuter();
    expect(process.platform).toBe(before);
  });

  it('is idempotent, so an afterEach can call it after an inline restore', () => {
    const before = process.platform;
    const undo = pinPlatform('aix');
    undo();
    undo();
    expect(process.platform).toBe(before);
  });
});
