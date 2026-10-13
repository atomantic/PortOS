import { expect, it } from 'vitest';
import { parseSecurityScanEvidence } from './securityScanEvidence.js';

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
