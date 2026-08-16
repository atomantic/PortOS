import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({ triageSystemResources: vi.fn() }));
vi.mock('../../services/api.js', () => api);
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{ id: 'codex', name: 'Codex' }],
    selectedProviderId: 'codex',
    selectedModel: '',
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));
vi.mock('../ProviderModelSelector.jsx', () => ({ default: () => <div>Triage provider</div> }));

const StoragePanel = (await import('./StoragePanel.jsx')).default;

const candidate = {
  id: 'data:cache',
  label: 'Cache',
  kind: 'data',
  estimatedBytes: 1024,
  risk: 'low',
  reason: 'Reproducible cache.',
  loaded: false,
  busy: false,
  manualOnly: false,
  managePath: '/data',
  action: { type: 'data-category', key: 'cache' },
};
const makeReport = (generatedAt) => ({
  generatedAt,
  filesystem: { totalBytes: 1000, usedBytes: 700, freeBytes: 300, usagePercent: 70 },
  sourceErrors: [],
  storageAreas: [],
  cleanupCandidates: [candidate],
});
const cleanup = {
  busyId: null,
  locked: false,
  isConfirming: vi.fn(() => false),
  request: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
};

function Harness() {
  const [report, setReport] = useState(makeReport('2026-08-16T00:00:00.000Z'));
  return (
    <StoragePanel
      report={report}
      loading={false}
      onRunReport={() => setReport(makeReport('2026-08-16T00:01:00.000Z'))}
      onReport={setReport}
      cleanup={cleanup}
    />
  );
}

describe('StoragePanel AI triage freshness', () => {
  it('clears recommendations when a newer report replaces their candidate snapshot', async () => {
    const user = userEvent.setup();
    const report = makeReport('2026-08-16T00:00:00.000Z');
    api.triageSystemResources.mockResolvedValue({
      report,
      triage: {
        summary: 'Remove the cache first.',
        recommendations: [{ candidate, priority: 'first', reason: 'Safe space.', tradeoff: 'Re-download later.' }],
        cautions: [],
      },
    });
    render(<MemoryRouter><Harness /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Ask AI to triage' }));
    expect(await screen.findByText('Remove the cache first.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh report' }));
    expect(screen.queryByText('Remove the cache first.')).not.toBeInTheDocument();
  });

  it('discards an in-flight triage response after the report is refreshed', async () => {
    const user = userEvent.setup();
    let finishTriage;
    api.triageSystemResources.mockReturnValue(new Promise((resolve) => { finishTriage = resolve; }));
    render(<MemoryRouter><Harness /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Ask AI to triage' }));
    await user.click(screen.getByRole('button', { name: 'Refresh report' }));
    finishTriage({
      report: makeReport('2026-08-16T00:00:00.000Z'),
      triage: {
        summary: 'Obsolete advice.',
        recommendations: [],
        cautions: [],
      },
    });

    expect(await screen.findByRole('button', { name: 'Ask AI to triage' })).toBeEnabled();
    expect(screen.queryByText('Obsolete advice.')).not.toBeInTheDocument();
  });
});
