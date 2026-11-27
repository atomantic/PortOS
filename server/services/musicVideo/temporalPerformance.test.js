import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from '../../lib/childProcess.js';
import { findCommandOnPath } from '../../lib/processEnv.js';
import { analyzeTemporalPerformance } from './temporalPerformance.js';

vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../../lib/processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()), findCommandOnPath: vi.fn(),
}));

const command = '/example/portos-temporal-analyzer';
const excerptPath = '/example/draft with spaces.mp4';
const shot = { sceneId: 'shot-1', speaker: 'Lead singer', startSec: 2, endSec: 5 };
const capabilities = { protocolVersion: 1, id: 'example', version: '1.2', ready: true, temporalLipSync: true, localOnly: true };
const analyzer = { protocolVersion: 1, id: 'example', version: '1.2' };
const span = { startSec: 2, endSec: 5, status: 'verified', offsetSec: -0.1, confidence: 0.8 };
const unmeasured = { ...shot, spans: [{ startSec: 2, endSec: 5, status: 'unverified', offsetSec: null, confidence: null }] };
const analyze = (shots = [shot]) => analyzeTemporalPerformance({ excerptPath, shots });
const reply = (value) => execFile.mockImplementationOnce((_command, _args, _options, callback) => {
  callback(null, { stdout: JSON.stringify(value) });
});

beforeEach(() => {
  vi.resetAllMocks();
  findCommandOnPath.mockReturnValue(command);
});

afterEach(() => vi.unstubAllEnvs());

describe('analyzeTemporalPerformance', () => {
  it('skips discovery for drafts without performance windows', async () => {
    expect(await analyze([])).toEqual({ version: 1, status: 'not-applicable', analyzer: null, reason: null, shots: [] });
    expect(findCommandOnPath).not.toHaveBeenCalled();
  });

  it.each([null, 'portos-temporal-analyzer.CMD'])('reports an unsupported executable as unavailable (%s)', async (candidate) => {
    findCommandOnPath.mockReturnValue(candidate);
    expect(await analyze()).toMatchObject({ status: 'unavailable', analyzer: null, shots: [unmeasured] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([{ localOnly: false }, { protocolVersion: 2 }, { ready: false }])('requires supported analyzer capabilities (%j)', async (overrides) => {
    reply({ ...capabilities, ...overrides });
    expect(await analyze()).toMatchObject({ status: 'unavailable', analyzer: null, shots: [unmeasured] });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('verifies contiguous evidence on the encoded excerpt with its embedded audio', async () => {
    vi.stubEnv('PORTOS_API_TOKEN', 'example-token');
    const spans = [{ ...span, endSec: 3 }, { ...span, startSec: 3 }];
    reply(capabilities);
    reply({ spans });

    expect(await analyze()).toEqual({ version: 1, status: 'verified', analyzer, reason: null, shots: [{ ...shot, spans }] });
    expect(execFile).toHaveBeenNthCalledWith(1, command, ['--capabilities'],
      expect.objectContaining({ timeout: 5000, maxBuffer: 256 * 1024 }), expect.any(Function));
    expect(execFile).toHaveBeenNthCalledWith(2, command, [
      '--analyze', '--video', excerptPath, '--audio', excerptPath, '--audio-start-sec', '0',
      '--start-sec', '2', '--end-sec', '5', '--speaker', 'Lead singer',
    ], expect.objectContaining({ timeout: expect.any(Number), killSignal: 'SIGKILL' }), expect.any(Function));
    for (const [, , options] of execFile.mock.calls) expect(options.env).not.toHaveProperty('PORTOS_API_TOKEN');
  });

  it.each([
    ['gap', [{ ...span, endSec: 3 }, { ...span, startSec: 3.1 }]],
    ['overlap', [{ ...span, endSec: 4 }, { ...span, startSec: 3 }]],
    ['overrun', [{ ...span, endSec: 6 }]],
    ['incomplete coverage', [{ ...span, endSec: 4 }]],
    ['malformed confidence', [{ ...span, confidence: 'high' }]],
    ['empty spans', []],
  ])('fails closed with an analyzer identity for %s', async (_label, spans) => {
    reply(capabilities);
    reply({ spans });
    expect(await analyze()).toMatchObject({ status: 'unverified', analyzer, shots: [unmeasured] });
  });

  it.each([{ confidence: 0.79 }, { offsetSec: null }, { status: 'unverified' }])('preserves inconclusive measurements (%j)', async (overrides) => {
    reply(capabilities);
    reply({ spans: [{ ...span, ...overrides }] });
    expect(await analyze()).toMatchObject({ status: 'unverified', analyzer,
      shots: [{ ...shot, spans: [{ ...span, ...overrides, status: 'unverified' }] }] });
  });

  it('discards partial verification when analysis of a later shot fails', async () => {
    reply(capabilities);
    reply({ spans: [span] });
    execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('Analyzer timed out')));
    const second = { ...shot, sceneId: 'shot-2', startSec: 5, endSec: 8 };

    expect(await analyze([shot, second])).toMatchObject({ status: 'unverified', analyzer,
      shots: [unmeasured, { ...second, spans: [{ startSec: 5, endSec: 8, status: 'unverified', offsetSec: null, confidence: null }] }] });
  });

  it('bounds oversized reviews before probing the executable', async () => {
    const result = await analyze(Array.from({ length: 257 }, () => shot));
    expect(result).toMatchObject({ status: 'unverified', analyzer: null, omittedShots: 1 });
    expect(result.shots).toHaveLength(256);
    expect(findCommandOnPath).not.toHaveBeenCalled();
  });
});
