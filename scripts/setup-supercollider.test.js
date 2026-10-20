import { describe, expect, it } from 'vitest';
import {
  BUILD_LINE_BUFFER_LIMIT,
  exitCodeForOutcome,
  isBuildStepLine,
  main,
  parseSuperColliderSetupArgs,
} from './setup-supercollider.js';

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

  function makeSimulatedBuildStream() {
    const lines = [
      '#1 [internal] load build definition from Dockerfile',
      '#2 [internal] load .dockerignore',
      '#3 [1/4] FROM debian:bookworm-slim',
      '#4 [2/4] RUN apt-get update && apt-get install -y',
    ];
    // ~100 apt lines with an E: error within the last 40 lines
    for (let i = 1; i <= 75; i++) {
      lines.push(`#4 1.${i} Get:${i} http://deb.debian.org/debian bookworm/main amd64 Packages [${i * 10} kB]`);
    }
    lines.push('#4 12.3 E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?');
    for (let i = 76; i <= 99; i++) {
      lines.push(`#4 12.${i} W: Failed to fetch http://deb.debian.org/debian/pool/main/pkg-${i}.deb`);
    }
    lines.push('#4 ERROR: process "/bin/sh -c apt-get update..." did not complete successfully: exit code: 100');
    lines.push('------ (buildkit excerpt)');
    lines.push(' > [2/4] RUN apt-get update && apt-get install -y:');
    lines.push('------------------------');
    lines.push('failed to solve: process "/bin/sh -c ..." did not complete successfully: exit code: 100');
    return lines;
  }

  const baseStatus = {
    docker: { installed: true, running: true, serverVersion: '27.0.3', os: 'linux', arch: 'x64' },
    image: null,
    smoke: null,
    runtime: { image: 'portos-supercollider:current' },
  };

  it('retains and prints at most 40 tail build lines including the E: error line on failure', async () => {
    const stdout = [];
    const stderr = [];
    const stream = makeSimulatedBuildStream();
    const buildError = 'failed to solve: process "/bin/sh -c ..." did not complete successfully: exit code: 100';

    const result = await main(['--yes'], {
      log: (m) => stdout.push(m),
      error: (m) => stderr.push(m),
      warn: (m) => stderr.push(m),
      setExitCode: false,
      setupSuperColliderRuntime: async ({ onLine }) => {
        for (const line of stream) onLine(line);
        return {
          outcome: 'build-failed',
          built: false,
          probed: false,
          error: buildError,
          status: { ...baseStatus, ready: false, message: 'Docker image build failed', action: 'Inspect Docker logs' },
        };
      },
    });

    expect(result.exitCode).toBe(4);

    // Verify step headers were printed during build to stdout
    expect(stdout).toContain('   #1 [internal] load build definition from Dockerfile');
    expect(stdout).toContain('   #4 [2/4] RUN apt-get update && apt-get install -y');

    // Verify failure output in stderr contains the error header, the E: line, and re-run advice
    const failureHeaderIdx = stderr.findIndex((l) => l.startsWith('❌ Image build failed:'));
    const rerunTipIdx = stderr.findIndex((l) => l === '👉 Re-run with --verbose for the full build log');

    expect(failureHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(rerunTipIdx).toBeGreaterThan(failureHeaderIdx);

    const retainedLines = stderr.slice(failureHeaderIdx + 1, rerunTipIdx);
    expect(retainedLines.length).toBeLessThanOrEqual(40);
    expect(retainedLines.length).toBe(BUILD_LINE_BUFFER_LIMIT);
    expect(retainedLines.some((l) => l.includes('E: Unable to fetch some archives'))).toBe(true);
    expect(retainedLines.every((l) => l.startsWith('   '))).toBe(true);
  });

  it('prints nothing extra on a successful build', async () => {
    const stdout = [];
    const stderr = [];
    const stream = makeSimulatedBuildStream();

    const result = await main(['--yes'], {
      log: (m) => stdout.push(m),
      error: (m) => stderr.push(m),
      warn: (m) => stderr.push(m),
      setExitCode: false,
      setupSuperColliderRuntime: async ({ onLine }) => {
        for (const line of stream) onLine(line);
        return {
          outcome: 'ready',
          built: true,
          probed: true,
          error: null,
          status: {
            ...baseStatus,
            ready: true,
            image: { current: true, sizeBytes: 150_000_000 },
            smoke: { ok: true, current: true, checkedAt: '2026-10-20', measurement: { durationMs: 50, channels: 2, sampleRate: 48000, peak: 0.9 } },
            message: 'SuperCollider runtime is ready',
          },
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.some((l) => l.includes('Re-run with --verbose'))).toBe(false);
    expect(stdout.some((l) => l.includes('E: Unable to fetch'))).toBe(false);
    // Non-step lines should not appear in stdout
    expect(stdout.some((l) => l.includes('W: Failed to fetch'))).toBe(false);
  });

  it('prints no duplicate lines on a non-verbose failure', async () => {
    const stdout = [];
    const stderr = [];
    const stream = makeSimulatedBuildStream();

    await main(['--yes'], {
      log: (m) => stdout.push(m),
      error: (m) => stderr.push(m),
      warn: (m) => stderr.push(m),
      setExitCode: false,
      setupSuperColliderRuntime: async ({ onLine }) => {
        for (const line of stream) onLine(line);
        return {
          outcome: 'build-failed',
          built: false,
          probed: false,
          error: 'build failed',
          status: { ...baseStatus, ready: false, message: 'Docker image build failed' },
        };
      },
    });

    const allOutputLines = [...stdout, ...stderr];
    const uniqueLines = new Set(allOutputLines);
    expect(uniqueLines.size).toBe(allOutputLines.length);

    // Specifically verify no line printed to stdout during build was repeated in stderr
    const overlap = stdout.filter((line) => stderr.includes(line));
    expect(overlap).toEqual([]);
  });

  it('keeps --verbose output unchanged on build failure', async () => {
    const stdout = [];
    const stderr = [];
    const stream = makeSimulatedBuildStream();

    const result = await main(['--yes', '--verbose'], {
      log: (m) => stdout.push(m),
      error: (m) => stderr.push(m),
      warn: (m) => stderr.push(m),
      setExitCode: false,
      setupSuperColliderRuntime: async ({ onLine }) => {
        for (const line of stream) onLine(line);
        return {
          outcome: 'build-failed',
          built: false,
          probed: false,
          error: 'build failed',
          status: { ...baseStatus, ready: false, message: 'Docker image build failed' },
        };
      },
    });

    expect(result.exitCode).toBe(4);
    // In verbose mode, every line is streamed to stdout
    expect(stdout.some((l) => l.includes('E: Unable to fetch'))).toBe(true);
    // stderr has the error header and status, but NO retained line buffer or re-run advice
    expect(stderr.some((l) => l.includes('Re-run with --verbose'))).toBe(false);
    expect(stderr.some((l) => l.includes('E: Unable to fetch'))).toBe(false);
  });
});
