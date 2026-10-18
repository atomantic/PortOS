import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  listUniverseSummaries: vi.fn(),
  listPipelineSeriesSummaries: vi.fn(),
}));
vi.mock('../services/api', () => api);

const importerApi = vi.hoisted(() => ({
  analyzeImport: vi.fn(), classifyImport: vi.fn(), commitImport: vi.fn(), retryImporterIssues: vi.fn(),
  getImporterConfig: vi.fn(), IMPORTER_CONTENT_TYPES: ['short-story', 'novel', 'screenplay', 'comic-script'],
  IMPORTER_SOURCE_CHAR_LIMIT_FALLBACK: 100_000, CLASSIFY_SOURCE_HEAD_CHARS: 10_000,
}));
vi.mock('../services/apiImporter', () => importerApi);
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({ providers: [], selectedProviderId: '', selectedModel: '', availableModels: [], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }),
}));
vi.mock('../hooks/useImporterProgress', () => ({
  useImporterProgress: () => ({ stages: null, reset: vi.fn() }),
  stageStatusIcon: () => null,
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import Importer from './Importer';

describe('Importer list reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listUniverseSummaries.mockRejectedValueOnce(new Error('universe offline')).mockResolvedValueOnce([]);
    api.listPipelineSeriesSummaries.mockRejectedValueOnce(new Error('series offline')).mockResolvedValueOnce([]);
    importerApi.getImporterConfig.mockResolvedValue({ sourceCharLimit: 100_000, arcRoles: [], arcShapeIds: null });
  });

  it('shows a retry row for both failed picker lists and retries each independently', async () => {
    render(<MemoryRouter><Importer /></MemoryRouter>);
    expect(await screen.findByText(/Could not load universes/)).toBeInTheDocument();
    expect(screen.getByText(/Could not load series/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Could not load universes/).closest('[role="alert"]').querySelector('button'));
    await waitFor(() => expect(screen.queryByText(/Could not load universes/)).toBeNull());
    fireEvent.click(screen.getByText(/Could not load series/).closest('[role="alert"]').querySelector('button'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.listUniverseSummaries).toHaveBeenCalledTimes(2);
    expect(api.listPipelineSeriesSummaries).toHaveBeenCalledTimes(2);
  });
});
