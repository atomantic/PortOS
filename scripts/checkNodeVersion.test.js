/**
 * Unit tests for the Node floor gate (issue #3863). The drift test next door
 * checks that every *site* agrees with MIN_NODE; this one checks that the gate
 * itself accepts and rejects the right versions — in particular that a v22.0
 * machine (which the coarse `-lt 22` shell gates wave through) is still
 * rejected by the precise check that `npm run setup` / `npm start` run.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  MIN_NODE,
  assertNodeVersion,
  compareVersions,
  parseVersion,
  satisfiesMinNode,
  unsupportedNodeMessage,
} from './checkNodeVersion.js';

describe('parseVersion', () => {
  it.each([
    ['v22.12.0', [22, 12, 0]],
    ['22.12.0', [22, 12, 0]],
    ['22.12', [22, 12, 0]],
    ['24', [24, 0, 0]],
    ['  24.1.2\n', [24, 1, 2]],
    ['22.12.0-nightly20240101', [22, 12, 0]],
  ])('parses %s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });
});

describe('compareVersions', () => {
  it.each([
    ['22.12.0', '22.12.0', 0],
    ['22.11.9', '22.12.0', -1],
    ['22.12.1', '22.12.0', 1],
    ['20.19.0', '22.12.0', -1],
    ['24.0.0', '22.12.0', 1],
    // Numeric, not lexical: "9" > "10" as strings, but not as versions.
    ['22.9.0', '22.10.0', -1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('satisfiesMinNode', () => {
  it('rejects the versions the coarse shell gates would let through', () => {
    // Major 22 clears `-lt 22`, but 22.0/22.11 are below the real Vite floor.
    expect(satisfiesMinNode('22.0.0')).toBe(false);
    expect(satisfiesMinNode('22.11.0')).toBe(false);
  });

  it('rejects the versions the README used to advertise', () => {
    expect(satisfiesMinNode('18.20.0')).toBe(false);
    expect(satisfiesMinNode('20.19.0')).toBe(false);
  });

  it('accepts the floor and everything above it', () => {
    expect(satisfiesMinNode(MIN_NODE)).toBe(true);
    expect(satisfiesMinNode('22.12.1')).toBe(true);
    expect(satisfiesMinNode('v24.0.0')).toBe(true);
  });

  it('defaults to the running interpreter, which must itself satisfy the floor', () => {
    expect(satisfiesMinNode()).toBe(true);
  });
});

describe('assertNodeVersion', () => {
  it('passes without invoking the failure path on a supported Node', () => {
    const onFail = vi.fn();
    expect(assertNodeVersion({ version: '24.1.0', onFail })).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('reports the required and found versions on an unsupported Node', () => {
    const onFail = vi.fn();
    expect(assertNodeVersion({ version: 'v20.19.0', onFail })).toBe(false);
    expect(onFail).toHaveBeenCalledTimes(1);
    const message = onFail.mock.calls[0][0];
    expect(message).toContain(MIN_NODE);
    expect(message).toContain('20.19.0');
  });

  it('does not double up the v prefix', () => {
    expect(unsupportedNodeMessage('v18.0.0')).toContain('found v18.0.0');
    expect(unsupportedNodeMessage('18.0.0')).toContain('found v18.0.0');
  });
});
