import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CodexUsagePreview from './CodexUsagePreview';

const api = vi.hoisted(() => ({ previewCodexUsage: vi.fn(), cancelCodexUsagePreview: vi.fn() }));
vi.mock('../../services/api', () => api);

it('requires bounds, starts only a preview, reconciles fast completion, and cancels the exact job', async () => {
  const job = { id: 'example-job', mode: 'preview', status: 'running' };
  const onStatus = vi.fn();
  const refreshStatus = vi.fn(async () => {});
  api.previewCodexUsage.mockResolvedValue(job);
  api.cancelCodexUsagePreview.mockResolvedValue({ ...job, status: 'cancelled' });
  const view = render(<CodexUsagePreview job={{ status: 'idle' }} onStatus={onStatus} refreshStatus={refreshStatus} />);
  expect(screen.getByRole('button', { name: 'Preview sources' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('To (UTC)'), { target: { value: '2026-09-01' } });
  expect(screen.getByRole('alert')).toHaveTextContent('1 to 366 days');
  fireEvent.change(screen.getByLabelText('To (UTC)'), { target: { value: '2026-10-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview sources' }));
  await waitFor(() => expect(onStatus).toHaveBeenCalledWith(job));
  expect(api.previewCodexUsage).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31' }, { silent: true });
  expect(refreshStatus).toHaveBeenCalledOnce();
  view.rerender(<CodexUsagePreview job={job} onStatus={onStatus} refreshStatus={refreshStatus} />);
  expect(screen.getByRole('button', { name: 'Preview sources' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }));
  await waitFor(() => expect(api.cancelCodexUsagePreview).toHaveBeenCalledWith('example-job', { silent: true }));
  await act(async () => {});
  view.rerender(<CodexUsagePreview job={{ ...job, status: 'cancelled' }} onStatus={onStatus} refreshStatus={refreshStatus} />);
  expect(screen.getByRole('status')).toHaveTextContent('Recorded usage is unchanged');
  expect(screen.getByRole('button', { name: 'Preview sources' })).toBeEnabled();
});

describe('preview evidence display', () => {
  it('names held Codex sources and shows nothing while the scan is healthy', () => {
    const props = { job: { status: 'idle' }, onStatus: vi.fn(), refreshStatus: vi.fn() };
    const view = render(<CodexUsagePreview {...props} coverage={null} />);
    expect(screen.queryByRole('note', { name: 'Codex usage on hold' })).toBeNull();
    view.rerender(<CodexUsagePreview {...props} coverage={{
      since: '2026-07-01T00:00:00Z', issues: { line_limit: 2 },
      sources: [{ source: 'sessions/example.jsonl', issues: ['line_limit'] }]
    }} />);
    const notice = screen.getByRole('note', { name: 'Codex usage on hold' });
    expect(notice).toHaveTextContent('line limit (2)');
    expect(notice).toHaveTextContent('sessions/example.jsonl: line limit');
    view.rerender(<CodexUsagePreview {...props} coverage={{
      since: '2026-07-01T00:00:00Z', issues: { indexing_pending: 3 }, sources: [], progress: { indexed: 1200, total: 1203 }
    }} />);
    expect(screen.getByRole('note', { name: 'Codex usage on hold' })).toHaveTextContent('Indexed 1,200 of 1,203 sources');
  });

  it('keeps incomplete coverage and unknown overlap explicit, with no apply action', () => {
    render(<CodexUsagePreview job={{ mode: 'preview', status: 'complete', preview: {
      range: { from: '2026-10-01', to: '2026-10-31' },
      coverage: { complete: false, filesInspected: 3, resolvedSessions: 1, unresolvedSessions: 1, issues: { conflicting_copies: 1 } },
      totals: { tokensIn: 100, cacheReadTokens: 20, tokensOut: 30 },
      byModel: { 'example-model': { tokensIn: 100, cacheReadTokens: 20, tokensOut: 30 } }
    } }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Source coverage incomplete');
    expect(screen.getByRole('status')).toHaveTextContent('conflicting copies (1)');
    expect(screen.getByRole('status')).toHaveTextContent('Prior ledger overlap is unknown');
    expect(screen.getByRole('status')).toHaveTextContent('No adjustments are available');
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
  });
});
