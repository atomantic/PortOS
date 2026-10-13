import { expect, it } from 'vitest';
import { parseSecurityScanEvidence, parseRunnerSecurityScanEvidence, securityScanGrantFromArgs, securityScanGrantSchema } from './securityScanEvidence.js';

const report = {
  version: 1, status: 'time-limit', model: 'example-model', effort: 'low', auth: 'chatgpt',
  maxCostUsd: 0, estimatedCostUsd: null, timeLimitSeconds: 600, exitCode: null,
  artifacts: { findings: true, coverage: null },
};
const parse = value => parseSecurityScanEvidence(`Delivered the requested change.\nSCANNER_STATUS_JSON: ${JSON.stringify(value)}`);

it('retains timeout evidence and distinguishes a zero budget from unknown values', () => {
  expect(parse(report)).toEqual({ ...report, source: 'agent-report' });
  expect(parse({ ...report, maxCostUsd: null }).maxCostUsd).toBeNull();
});

it('rejects fabricated completion, ambiguous reports and fields that could disclose private data', () => {
  expect(parse({ ...report, status: 'completed' })).toBeNull();
  expect(parse({ ...report, outputDir: '/private/artifacts' })).toBeNull();
  expect(parse({ ...report, model: '/private/model' })).toBeNull();
  expect(parseSecurityScanEvidence('Completed successfully')).toBeNull();
  expect(parseSecurityScanEvidence(`SCANNER_STATUS_JSON: ${JSON.stringify(report)}\nSCANNER_STATUS_JSON: ${JSON.stringify(report)}`)).toBeNull();
});

it('derives scanner pins from effective argv and refuses conflicting or implicit defaults', () => {
  expect(securityScanGrantFromArgs(['--model', 'saved-model', '-c', 'model_reasoning_effort="high"'])).toEqual({ model: 'saved-model', effort: 'high', auth: 'chatgpt', maxCostUsd: 25, timeLimitSeconds: 1200 });
  expect(securityScanGrantFromArgs(['--model=selected-model', '--config=model="another-model"', '-cmodel_reasoning_effort=low'])).toMatchObject({ model: null, effort: 'low' });
  expect(securityScanGrantFromArgs([])).toEqual({ model: null, effort: null, auth: 'chatgpt', maxCostUsd: 25, timeLimitSeconds: 1200 });
});

it('preserves legacy grants and rejects mixed limits or authentication overrides', () => {
  const legacy = { model: 'saved-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 2, timeLimitSeconds: 180 };
  expect(securityScanGrantSchema.parse(legacy)).toEqual(legacy);
  for (const override of [{ maxCostUsd: 25 }, { timeLimitSeconds: 1200 }, { maxCostUsd: 100, timeLimitSeconds: 3600 }, { auth: 'api-key' }, { auth: 'auto' }]) {
    expect(securityScanGrantSchema.safeParse({ ...legacy, ...override }).success).toBe(false);
  }
});

it('accepts bounded runner input diagnostics without allowing private paths or errors through', () => {
  const evidence = { ...report, status: 'invalid-input', source: 'runner', sequence: 2,
    preflight: { rejectedRequests: 1, lastError: { field: 'paths', index: 0, code: 'path-not-found' } } };
  expect(parseRunnerSecurityScanEvidence(evidence)).toEqual(evidence);
  expect(parseRunnerSecurityScanEvidence({ ...evidence, preflight: {
    ...evidence.preflight, lastError: { ...evidence.preflight.lastError, path: '/private/source.js' },
  } })).toBeNull();
  expect(parseRunnerSecurityScanEvidence({ ...evidence, preflight: {
    ...evidence.preflight, lastError: { ...evidence.preflight.lastError, code: 'raw private error' },
  } })).toBeNull();
});
