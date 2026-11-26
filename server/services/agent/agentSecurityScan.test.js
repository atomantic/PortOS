import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentRecord = vi.hoisted(() => vi.fn());
const updateAgent = vi.hoisted(() => vi.fn());
const getAgentDir = vi.hoisted(() => vi.fn(() => '/no-agent-files'));
const requestSecurityScanViaRunner = vi.hoisted(() => vi.fn());
vi.mock('../cos/cosAgentLifecycle.js', () => ({ getAgentRecord, updateAgent }));
vi.mock('../cos/cosAgentIndex.js', () => ({ getAgentDir }));
vi.mock('../cos/cosRunnerClient.js', () => ({ requestSecurityScanViaRunner }));

import { persistAgentSecurityScan, runAgentSecurityScan, settleAgentSecurityScan } from './agentSecurityScan.js';
import { ServerError } from '../../lib/errorHandler.js';

const valid = (status = 'running', extra = {}) => ({ source: 'runner', sequence: 1, version: 1, status,
  model: 'example-model', effort: 'low', auth: 'chatgpt', maxCostUsd: 'unlimited', estimatedCostUsd: null,
  timeLimitSeconds: 'unlimited', exitCode: null, artifacts: { findings: null, coverage: null }, ...extra });
const running = () => ({ id: 'agent-a', status: 'running', metadata: { taskAnalysisType: 'security', useRunner: true } });

beforeEach(() => {
  vi.clearAllMocks();
  getAgentRecord.mockResolvedValue(running());
  updateAgent.mockResolvedValue({ metadata: {} });
  requestSecurityScanViaRunner.mockResolvedValue({ evidence: valid() });
});

describe('runAgentSecurityScan', () => {
  it.each([
    ['unknown agent', null],
    ['completed agent', { ...running(), status: 'completed' }],
    ['non-security task', { ...running(), metadata: { taskAnalysisType: 'code-quality', useRunner: true } }],
    ['non-runner agent', { ...running(), metadata: { taskAnalysisType: 'security', useRunner: false } }],
  ])('rejects an %s without calling the runner', async (_label, record) => {
    getAgentRecord.mockResolvedValue(record);
    await expect(runAgentSecurityScan('agent-a', { prompt: 'test' })).rejects.toBeInstanceOf(ServerError);
    expect(requestSecurityScanViaRunner).not.toHaveBeenCalled();
  });

  it('runs and persists evidence only for an active runner-owned security audit', async () => {
    const result = { evidence: valid('completed', { exitCode: 0 }) };
    requestSecurityScanViaRunner.mockResolvedValue(result);
    await expect(runAgentSecurityScan('agent-a', { prompt: 'test' })).resolves.toBe(result);
    expect(requestSecurityScanViaRunner).toHaveBeenCalledWith('agent-a', { input: { prompt: 'test' } });
    expect(updateAgent).toHaveBeenCalledWith('agent-a', { metadata: expect.objectContaining({ securityScan: expect.objectContaining({ status: 'completed' }), securityScanControl: null }) });
  });
});

describe('persistAgentSecurityScan', () => {
  it('ignores malformed runner evidence', async () => {
    await expect(persistAgentSecurityScan('agent-a', { status: 'completed' })).resolves.toBeNull();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('records content refusal only for refused status', async () => {
    await persistAgentSecurityScan('agent-a', valid('refused'));
    expect(updateAgent).toHaveBeenLastCalledWith('agent-a', { metadata: expect.objectContaining({
      executionInterruption: expect.objectContaining({ category: 'content-refusal', source: 'security-scanner' }),
    }) });
    updateAgent.mockClear();
    await persistAgentSecurityScan('agent-a', valid('failed'));
    expect(updateAgent.mock.calls[0][1].metadata).not.toHaveProperty('executionInterruption');
  });

  it('clears scan control only for terminal status', async () => {
    await persistAgentSecurityScan('agent-a', valid('running'));
    expect(updateAgent.mock.calls[0][1].metadata).not.toHaveProperty('securityScanControl');
    await persistAgentSecurityScan('agent-a', valid('completed', { exitCode: 0 }));
    expect(updateAgent.mock.calls[1][1].metadata.securityScanControl).toBeNull();
  });
});

describe('settleAgentSecurityScan', () => {
  it('ignores non-security and non-runner records', async () => {
    getAgentRecord.mockResolvedValueOnce({ ...running(), metadata: { taskAnalysisType: 'code-quality', useRunner: true } });
    await expect(settleAgentSecurityScan('agent-a')).resolves.toBeNull();
    getAgentRecord.mockResolvedValueOnce({ ...running(), metadata: { taskAnalysisType: 'security', useRunner: false } });
    await expect(settleAgentSecurityScan('agent-a')).resolves.toBeNull();
    expect(requestSecurityScanViaRunner).not.toHaveBeenCalled();
  });

  it('marks unreachable running evidence interrupted without persisting a forged terminal scan', async () => {
    requestSecurityScanViaRunner.mockRejectedValue(new Error('runner unavailable'));
    getAgentRecord.mockResolvedValue({ ...running(), metadata: { taskAnalysisType: 'security', useRunner: true, securityScan: valid() } });
    await expect(settleAgentSecurityScan('agent-a')).resolves.toMatchObject({ status: 'interrupted', cleanup: 'unconfirmed' });
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith('agent-a', { metadata: { securityScanControl: { status: 'interrupted', cleanup: 'unconfirmed' } } });
  });

  it('falls back to saved security-scan evidence when the runner returns no usable evidence', async () => {
    requestSecurityScanViaRunner.mockResolvedValue({ evidence: null });
    getAgentRecord.mockResolvedValue({ ...running(), metadata: { taskAnalysisType: 'security', useRunner: true, securityScan: valid('failed') } });
    await expect(settleAgentSecurityScan('agent-a')).resolves.toMatchObject({ status: 'failed' });
    expect(updateAgent).toHaveBeenCalledWith('agent-a', { metadata: expect.objectContaining({ securityScan: expect.objectContaining({ status: 'failed' }) }) });
  });
});
