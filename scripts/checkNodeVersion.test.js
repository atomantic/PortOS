/**
 * Unit tests for the Node runtime gate (issue #3863). The drift test next door
 * checks that every *site* agrees with MIN_NODE; this one checks that the gate
 * itself accepts and rejects the right versions — in particular that excluded
 * Node release lines do not pass a coarse major-only gate.
 * rejected by the precise check that `npm run setup` / `npm start` run.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  MIN_NODE,
  MIN_NODE_24,
  SUPPORTED_NODE_RANGE,
  assertNodeVersion,
  compareVersions,
  parseVersion,
  satisfiesVersionRequirement,
  satisfiesMinNode,
  unsupportedNodeMessage,
} from './checkNodeVersion.js';

describe('parseVersion', () => {
  it.each([
    ['v22.22.2', [22, 22, 2]],
    ['22.22.2', [22, 22, 2]],
    ['22.22', [22, 22, 0]],
    ['24', [24, 0, 0]],
    ['  24.1.2\n', [24, 1, 2]],
    ['22.22.2-nightly20240101', [22, 22, 2]],
  ])('parses %s', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });
});

describe('compareVersions', () => {
  it.each([
    ['22.22.2', '22.22.2', 0],
    ['22.22.1', '22.22.2', -1],
    ['22.22.3', '22.22.2', 1],
    ['20.19.0', '22.22.2', -1],
    ['24.0.0', '22.22.2', 1],
    // Numeric, not lexical: "9" > "10" as strings, but not as versions.
    ['22.9.0', '22.10.0', -1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('satisfiesVersionRequirement', () => {
  it('supports the engine-range syntax used by the manifests', () => {
    expect(satisfiesVersionRequirement('22.22.2', SUPPORTED_NODE_RANGE)).toBe(true);
    expect(satisfiesVersionRequirement('24.15.0', SUPPORTED_NODE_RANGE)).toBe(true);
    expect(satisfiesVersionRequirement('26.0.0', SUPPORTED_NODE_RANGE)).toBe(true);
    expect(satisfiesVersionRequirement('23.0.0', SUPPORTED_NODE_RANGE)).toBe(false);
    expect(satisfiesVersionRequirement('not-a-version', SUPPORTED_NODE_RANGE)).toBe(null);
  });
});

describe('satisfiesMinNode', () => {
  it.each([
    ['22.0.0', false],
    ['22.22.1', false],
    ['23.0.0', false],
    ['24.0.0', false],
    ['24.14.0', false],
    ['25.0.0', false],
    ['18.20.0', false],
    ['20.19.0', false],
    [MIN_NODE, true],
    [MIN_NODE_24, true],
    ['22.23.0', true],
    ['24.20.0', true],
    ['v26.0.0', true],
  ])('returns %s -> %s', (version, expected) => {
    expect(satisfiesMinNode(version)).toBe(expected);
  });

  it('defaults to the running interpreter, which must itself satisfy the range', () => {
    // Keep the assertion — CI must run a supported Node, and every other case
    // here passes an explicit version, so this is the only one that proves the
    // no-argument default reads `process.versions.node` at all. What it must
    // NOT do is fail as a bare `expected false to be true` (#7951): on a
    // developer machine one release behind, that reads like a regression in the
    // branch under test and costs a round of triage in a suite the change never
    // touched. Name the environment instead.
    expect(
      satisfiesMinNode(),
      `This interpreter is Node ${process.versions.node}, which does not satisfy `
        + `package.json engines.node (${SUPPORTED_NODE_RANGE}). That is an environment `
        + 'mismatch on this machine, not a defect in the code under test — upgrade Node '
        + 'to a supported release. CI runs a supported Node, where this passes.',
    ).toBe(true);
  });
});

describe('assertNodeVersion', () => {
  it('passes without invoking the failure path on a supported Node', () => {
    const onFail = vi.fn();
    expect(assertNodeVersion({ version: '24.15.0', onFail })).toBe(true);
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
    expect(unsupportedNodeMessage(' v18.0.0 ')).toContain('found v18.0.0');
  });
});
