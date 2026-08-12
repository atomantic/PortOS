/**
 * The series' own backend pin (Series → render pin row) has to reach the comic
 * page / cover render bodies (#3840): those POST an EXPLICIT `mode`, and an
 * explicit mode outranks every record pin on the server ladder
 * (`resolveRenderTargetConfig`). Before this, a series pinned to agy rendered
 * its covers on whatever the install-wide default resolved to.
 *
 * Asserts the WIRE BODY (what the server actually receives), not an internal
 * memo — the memo is where the bug lived, the body is what proves it's fixed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  PIPELINE_STAGE_LABELS: { comicScript: 'Comic Script' },
  PIPELINE_STAGE_STATUS_LABEL: { empty: 'Empty', ready: 'Ready' },
  PIPELINE_STAGE_STATUS_COLOR: {},
  generatePipelineStage: vi.fn(),
  extractPipelineComicPages: vi.fn(),
  generatePipelineComicPage: vi.fn(),
  generatePipelineComicCover: vi.fn(),
  generatePipelineComicBackCover: vi.fn(),
  generatePipelineComicCoverConcepts: vi.fn(),
  updatePipelineComicPage: vi.fn(),
  refinePipelineComicPageRender: vi.fn(),
  updatePipelineIssue: vi.fn(),
}));
vi.mock('../../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
vi.mock('../../../services/apiImageVideo', () => ({ listImageModels: vi.fn() }));
vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import ComicScriptStage from './ComicScriptStage';
import { generatePipelineComicCover } from '../../../services/api';
import { getSettings } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';

// Both cloud CLIs enabled, so `readPipelineImageSettings` resolves the
// install-wide default to codex — which means an observed 'agy' can ONLY have
// come from a pin.
const CLOUD_ON = { codex: { enabled: true }, agy: { enabled: true } };

const issue = {
  id: 'iss-1',
  seriesId: 'ser-1',
  stages: {
    comicScript: { status: 'ready', output: '' },
    comicPages: { pages: [], cover: { script: 'Cover concept' } },
  },
};
const series = { id: 'ser-1', name: 'Example Series' };

const renderStage = (seriesRecord = series) => render(
  <MemoryRouter>
    <ComicScriptStage issue={issue} series={seriesRecord} onStageUpdate={vi.fn()} />
  </MemoryRouter>,
);

// The cover "Render proof" button is the shortest path to a render body; the
// page renders build theirs from the same `renderOpts`.
const clickRenderProof = async () => {
  // Flush the mount-time settings + model fetch. Clicking before those land
  // would capture PIPELINE_IMAGE_DEFAULTS ('local') instead of the resolved
  // ladder, and every case below would pass for the wrong reason.
  await act(async () => { await Promise.resolve(); });
  const buttons = await screen.findAllByRole('button', { name: /Render proof/i });
  await userEvent.click(buttons[0]);
  await waitFor(() => expect(generatePipelineComicCover).toHaveBeenCalled());
  return generatePipelineComicCover.mock.calls[0][1];
};

beforeEach(() => {
  vi.clearAllMocks();
  listImageModels.mockResolvedValue([]);
  generatePipelineComicCover.mockResolvedValue({ jobId: 'job-1', mode: 'agy' });
});

describe('ComicScriptStage — series render pin (#3840)', () => {
  it('folds the series pin over the install-wide settings default', async () => {
    getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
    renderStage({ ...series, imageMode: 'agy', imageModelId: 'gemini-3.5-pro' });
    const body = await clickRenderProof();
    expect(body.mode).toBe('agy');
    expect(body.cloudModel).toBe('gemini-3.5-pro');
  });

  it('keeps the install-wide default for an unpinned series', async () => {
    getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
    renderStage();
    const body = await clickRenderProof();
    expect(body.mode).toBe('codex');
  });

  it('falls through an unpinned series to the pipeline-visual renderDefaults pin', async () => {
    getSettings.mockResolvedValue({
      imageGen: CLOUD_ON,
      renderDefaults: { 'pipeline-visual': { imageMode: 'agy', imageModel: 'gemini-3.5-pro' } },
    });
    renderStage();
    const body = await clickRenderProof();
    expect(body.mode).toBe('agy');
    expect(body.cloudModel).toBe('gemini-3.5-pro');
  });

  it('ignores a pin whose backend this install no longer has enabled', async () => {
    getSettings.mockResolvedValue({ imageGen: { codex: { enabled: true } } });
    renderStage({ ...series, imageMode: 'agy' });
    const body = await clickRenderProof();
    expect(body.mode).toBe('codex');
  });
});
