import { describe, expect, it } from 'vitest';
import { exitCodeForOutcome, isBuildStepLine, parseSuperColliderSetupArgs } from './setup-supercollider.js';

describe('SuperCollider setup CLI', () => {
  it('accepts only the documented flags', () => {
    expect(parseSuperColliderSetupArgs(['--yes', '--rebuild'])).toMatchObject({ yes: true, rebuild: true, status: false });
    expect(parseSuperColliderSetupArgs(['--status', '--json'])).toMatchObject({ status: true, json: true });
    expect(() => parseSuperColliderSetupArgs(['--force'])).toThrow('Unknown option');
    expect(() => parseSuperColliderSetupArgs(['--json'])).toThrow('only valid with --status');
  });

  it('gives each failure its own non-zero exit code', () => {
    const outcomes = ['docker-unavailable', 'declined', 'build-failed', 'smoke-failed'];
    expect(exitCodeForOutcome('ready')).toBe(0);
    expect(new Set(outcomes.map(exitCodeForOutcome)).size).toBe(outcomes.length);
    expect(outcomes.map(exitCodeForOutcome).every((code) => code > 1)).toBe(true);
    expect(exitCodeForOutcome('something-new')).toBe(1);
  });

  it('keeps default build output to step headers', () => {
    expect(isBuildStepLine('#7 [build 3/5] RUN set -eux; cmake -S /src -B /build')).toBe(true);
    expect(isBuildStepLine('Step 4/12 : RUN apt-get update')).toBe(true);
    expect(isBuildStepLine('#7 412.3 [ 61%] Building CXX object server/plugins/BinaryOpUGens.cpp.o')).toBe(false);
  });
});
