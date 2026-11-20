import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'ml', 'music_benchmark.py');
const pyBin = resolveTestPython();
const PRELUDE = [
  'import importlib.util, json, math, os, struct, sys, tempfile, wave',
  'spec = importlib.util.spec_from_file_location("music_benchmark", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  'def write_wav(path, values, sample_rate=32000, channels=2):',
  '    with wave.open(path, "wb") as wav:',
  '        wav.setnchannels(channels); wav.setsampwidth(2); wav.setframerate(sample_rate)',
  '        wav.writeframes(b"".join(struct.pack("<h", value) * channels for value in values))',
].join('\n');

const runPython = (body) => execFileSync(pyBin, ['-c', `${PRELUDE}\n${body}`, script], {
  encoding: 'utf8',
}).trim();

describe.skipIf(!pyBin)('music benchmark analyzer', () => {
  it('records text shape and technical metadata without retaining prompt content', () => {
    const output = runPython([
      'path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name',
      'write_wav(path, [int(12000 * math.sin(2 * math.pi * 440 * index / 32000)) for index in range(32000)])',
      'report = mod.build_report(path, "Example prompt", "[Instrumental]", 1, "diffusers-example", "balanced", 1234, 2048, 17)',
      'print(json.dumps(report))',
      'os.unlink(path)',
    ].join('\n'));
    const report = JSON.parse(output);

    expect(report.input.promptShape).toEqual({ characters: 14, words: 2, lines: 1 });
    expect(report.input.lyricsShape).toEqual({ characters: 14, words: 1, lines: 1 });
    expect(report.input).not.toHaveProperty('prompt');
    expect(report.run).toMatchObject({
      seed: 17,
      requestedDurationSec: 1,
      backendVersion: 'diffusers-example',
      profile: 'balanced',
      elapsedMs: 1234,
      peakVramMb: 2048,
    });
    expect(report.audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.validation).toEqual({ status: 'passed', errors: [] });
    expect(report.review).toEqual({
      listeningRequired: true,
      status: 'pending',
      metricsAreNotSubjectiveApproval: true,
    });
  });

  it('rejects silence, clipping, and duration drift', () => {
    const output = runPython([
      'path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name',
      'write_wav(path, [32767] * 20 + [0] * 7980)',
      'report = mod.build_report(path, "p", "l", 1, "backend", "profile", 1, 1, 1, duration_tolerance_sec=0.1)',
      'print(json.dumps(report["validation"]))',
      'os.unlink(path)',
    ].join('\n'));
    const validation = JSON.parse(output);

    expect(validation.status).toBe('rejected');
    expect(validation.errors.join('\n')).toMatch(/near-silent|too much silence/);
    expect(validation.errors.join('\n')).toMatch(/clipping/);
    expect(validation.errors.join('\n')).toMatch(/unexpected duration/);
  });

  it('rejects a large spectral change against a baseline report', () => {
    const output = runPython([
      'baseline_path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name',
      'current_path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name',
      'write_wav(baseline_path, [int(12000 * math.sin(2 * math.pi * 440 * index / 32000)) for index in range(32000)])',
      'write_wav(current_path, [int(12000 * math.sin(2 * math.pi * 8000 * index / 32000)) for index in range(32000)])',
      'baseline = mod.build_report(baseline_path, "p", "l", 1, "backend", "profile", 1, 1, 1)',
      'current = mod.build_report(current_path, "p", "l", 1, "backend", "profile", 1, 1, 1, baseline_report=baseline, max_spectral_drift=0.05)',
      'print(json.dumps({"drift": current["audio"]["spectralDrift"], "validation": current["validation"]}))',
      'os.unlink(baseline_path); os.unlink(current_path)',
    ].join('\n'));
    const result = JSON.parse(output);

    expect(result.drift).toBeGreaterThan(0.05);
    expect(result.validation.status).toBe('rejected');
    expect(result.validation.errors.join('\n')).toContain('catastrophic spectral drift');
  });

  it('reports malformed WAV output as a technical rejection', () => {
    const output = runPython([
      'path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name',
      'with open(path, "wb") as raw: raw.write(b"not a wav")',
      'report = mod.build_report(path, "p", "l", 1, "backend", "profile", 1, 1, 1)',
      'print(json.dumps(report["validation"]))',
      'os.unlink(path)',
    ].join('\n'));
    const validation = JSON.parse(output);

    expect(validation.status).toBe('rejected');
    expect(validation.errors.join('\n')).toMatch(/invalid WAV|file does not start with RIFF id/);
  });
});
