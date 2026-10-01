/**
 * Optional LOCAL temporal analyzer protocol. Never installs, downloads or calls
 * a paid provider. The operator installs portos-temporal-analyzer on PATH.
 * Capability and result validation fail closed; stills and duration parity
 * cannot supply this evidence. Times are on the encoded excerpt's timeline.
 */
import { promisify } from 'util';
import { z } from 'zod';
import { execFile } from '../../lib/childProcess.js';
import { findCommandOnPath, safeChildProcessOptions } from '../../lib/processEnv.js';

const execFileAsync = promisify(execFile);
const identity = z.string().trim().min(1).max(128);
const capabilities = z.object({
  protocolVersion: z.literal(1), id: identity, version: identity,
  ready: z.literal(true), temporalLipSync: z.literal(true), localOnly: z.literal(true),
});
const resultSchema = z.object({
  spans: z.array(z.object({
    startSec: z.number().finite().nonnegative(), endSec: z.number().finite().positive(),
    status: z.enum(['verified', 'unverified']),
    offsetSec: z.number().finite().min(-5).max(5).nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
  })).min(1).max(256),
});
const unavailable = (shots, reason, analyzer = null) => ({
  version: 1, status: 'unverified', analyzer, reason,
  shots: shots.map((shot) => ({ ...shot, spans: [{ startSec: shot.startSec, endSec: shot.endSec, status: 'unverified', offsetSec: null, confidence: null }] })),
});

// A local executable receives only runtime essentials, never agent/provider or
// forge credentials. All invocations are bounded and argv-only.
const analyzerEnv = () => Object.fromEntries(
  ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG']
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
);
const invoke = async (command, args, timeout) => {
  const { stdout } = await execFileAsync(command, args, safeChildProcessOptions({
    env: analyzerEnv(), timeout, maxBuffer: 256 * 1024,
  }));
  return JSON.parse(stdout);
};

/** Called only by an explicitly requested draft review. */
export async function analyzeTemporalPerformance({ excerptPath, shots }) {
  if (!shots.length) return { version: 1, status: 'not-applicable', analyzer: null, reason: null, shots: [] };
  const command = findCommandOnPath('portos-temporal-analyzer');
  if (!command || /\.(cmd|bat)$/i.test(command)) return unavailable(shots, 'No supported local temporal analyzer is installed');
  const capability = await invoke(command, ['--capabilities'], 5000).then((value) => capabilities.safeParse(value), () => null);
  if (!capability?.success) return unavailable(shots, 'The installed temporal analyzer is unavailable or unsupported');
  const analyzer = { id: capability.data.id, version: capability.data.version, protocolVersion: 1 };
  const measured = [];
  const deadline = Date.now() + 60_000;
  let spanCount = 0;
  for (const shot of shots) {
    // Analyze the ACTUAL output against its embedded song audio. Source-file
    // preparation and the current (possibly changed) master prove no output sync.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return unavailable(shots, 'The temporal analyzer exceeded the review time limit', analyzer);
    const response = await invoke(command, [
      '--analyze', '--video', excerptPath, '--audio', excerptPath,
      '--audio-start-sec', '0', '--start-sec', String(shot.startSec), '--end-sec', String(shot.endSec),
      '--speaker', shot.speaker || '',
    ], remainingMs).then((value) => resultSchema.safeParse(value), () => null);
    if (!response?.success) return unavailable(shots, 'The temporal analyzer returned missing or malformed evidence', analyzer);
    const spans = response.data.spans;
    spanCount += spans.length;
    if (spanCount > 256) return unavailable(shots, 'The temporal analyzer exceeded the evidence span limit', analyzer);
    let cursor = shot.startSec;
    // Require complete ordered coverage. Gaps, overlaps, non-finite values and
    // out-of-window results never become a partial pass.
    for (const span of spans) {
      if (Math.abs(span.startSec - cursor) > 0.001 || span.endSec <= span.startSec || span.endSec > shot.endSec) {
        return unavailable(shots, 'The temporal analyzer returned invalid span coverage', analyzer);
      }
      cursor = span.endSec;
    }
    if (Math.abs(cursor - shot.endSec) > 0.001) return unavailable(shots, 'The temporal analyzer did not cover the performance window', analyzer);
    measured.push({ ...shot, spans: spans.map((span) => ({
      ...span,
      status: span.status === 'verified' && span.offsetSec !== null && span.confidence >= 0.8 ? 'verified' : 'unverified',
    })) });
  }
  const verified = measured.every((shot) => shot.spans.every((span) => span.status === 'verified'));
  return { version: 1, status: verified ? 'verified' : 'unverified', analyzer, reason: verified ? null : 'Temporal evidence is inconclusive — review the performance by ear', shots: measured };
}
