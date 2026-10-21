import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../../../services/apiUniverseBuilder', () => ({
  refineUniverseCharacter: vi.fn(),
  getUniverseSeriesNames: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../services/apiPipeline', () => ({
  extractPipelineCanonFromScript: vi.fn(),
  describePipelineCanonFromProse: vi.fn(),
}));
vi.mock('../../../services/apiProviders', () => ({ getProviders: vi.fn(() => Promise.resolve({ providers: [] })) }));
vi.mock('../../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock('../../../services/apiImageVideo', () => ({ listImageModels: vi.fn() }));
vi.mock('../../../hooks/useUniverse', () => ({
  default: () => [{ id: 'uni-1', name: 'Example Universe', characters: [], places: [], objects: [] }, vi.fn()],
}));
vi.mock('../../../hooks/useCanonPatch', () => ({ useCanonPatch: () => vi.fn() }));
vi.mock('../../media/MediaPreview', () => ({ default: () => null }));

import NounsStage from './NounsStage';
import { getSettings } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';

const issue = { id: 'iss-1', seriesId: 'ser-1', stages: { prose: { output: 'Prose text.' } } };
const series = { id: 'ser-1', name: 'Example Series', universeId: 'uni-1' };

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
});

describe('NounsStage — image model catalog', () => {
  it('shows a catalog error with Retry in the settings drawer when the model read fails', async () => {
    listImageModels.mockRejectedValueOnce(new Error('Models unavailable'));
    render(
      <MemoryRouter initialEntries={['/?settings=noun-image']}>
        <NounsStage issue={issue} series={series} onStageUpdate={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the local model catalog — Models unavailable');

    listImageModels.mockResolvedValueOnce([{ id: 'model-a', name: 'Model A' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
