import { useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import toast from '../../ui/Toast';
import { getUniverse, getUniverseSeriesNames, patchUniverseCanonEntry, refineUniverseCharacter } from '../../../services/apiUniverseBuilder';
import { describePipelineCanonFromProse, extractPipelineCanonFromScript } from '../../../services/apiPipeline';
import { getProviders } from '../../../services/apiProviders';
import { generateImage, getSettings, patchSettingsSlice } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import { getMediaJob } from '../../../services/apiMediaJobs';
import socket from '../../../services/socket';
import NounsStage from './NounsStage';

vi.mock('../../ui/Toast');
vi.mock('../../../services/apiUniverseBuilder', () => ({
  getUniverse: vi.fn(),
  getUniverseSeriesNames: vi.fn(),
  patchUniverseCanonEntry: vi.fn(),
  refineUniverseCharacter: vi.fn(),
}));
vi.mock('../../../services/apiPipeline', () => ({
  extractPipelineCanonFromScript: vi.fn(),
  describePipelineCanonFromProse: vi.fn(),
}));
vi.mock('../../../services/apiProviders', () => ({ getProviders: vi.fn() }));
vi.mock('../../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock('../../../services/apiImageVideo', () => ({ listImageModels: vi.fn() }));
vi.mock('../../../services/apiMediaJobs', () => ({ getMediaJob: vi.fn() }));
vi.mock('../../../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

const issue = {
  id: 'iss-1',
  seriesId: 'ser-1',
  stages: { prose: { output: 'Cedar meets Flint at the observatory.', status: 'complete' } },
};
const series = {
  id: 'ser-1', name: 'Example Series', universeId: 'uni-1',
  llm: { provider: 'series-provider', model: 'series-model' },
};
const cedar = { id: 'char-1', name: 'Cedar', physicalDescription: 'A gray cloak.' };
const universe = { id: 'uni-1', name: 'Example Universe', characters: [], places: [], objects: [] };

function mountStage(url = '/') {
  const onStageUpdate = vi.fn();
  function IssueEditor() {
    const [current, setCurrent] = useState(issue);
    return <NounsStage issue={current} series={series} onStageUpdate={(stage, data, updatedIssue) => {
      onStageUpdate(stage, data, updatedIssue);
      setCurrent(updatedIssue || { ...current, stages: { ...current.stages, [stage]: data } });
    }} />;
  }
  render(<MemoryRouter initialEntries={[url]}><IssueEditor /></MemoryRouter>);
  return { user: userEvent.setup(), onStageUpdate };
}

beforeEach(() => {
  vi.resetAllMocks();
  getUniverse.mockResolvedValue(universe);
  getUniverseSeriesNames.mockResolvedValue([]);
  getProviders.mockResolvedValue({
    providers: [
      { id: 'series-provider', name: 'Series provider', models: ['series-model'] },
      { id: 'example-provider', name: 'Example provider', models: ['example-model'] },
    ],
  });
  getSettings.mockResolvedValue({});
  listImageModels.mockResolvedValue([]);
  getMediaJob.mockResolvedValue({ status: 'queued' });
});

describe('NounsStage', () => {
  it('shows a catalog error with Retry in the settings drawer when the model read fails', async () => {
    listImageModels.mockRejectedValueOnce(new Error('Models unavailable'));
    const { user } = mountStage('/?settings=noun-image');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the local model catalog — Models unavailable');

    listImageModels.mockResolvedValueOnce([{ id: 'model-a', name: 'Model A' }]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('uses the extraction picker, then renders the extracted universe and propagates the stamped prose', async () => {
    const prose = { ...issue.stages.prose, canonExtraction: { status: 'ok', extracted: { characters: 1 } } };
    const updatedIssue = { ...issue, stages: { prose } };
    extractPipelineCanonFromScript.mockResolvedValue({
      issue: updatedIssue, universe: { ...universe, characters: [cedar] }, extracted: { characters: 1 },
    });
    const { user, onStageUpdate } = mountStage();
    await screen.findByRole('option', { name: 'Example provider' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Extraction provider' }), 'example-provider');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'example-model');
    expect(screen.queryByText('Cedar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Extract from prose' }));

    expect(extractPipelineCanonFromScript).toHaveBeenCalledWith(issue.id, 'prose', {
      providerOverride: 'example-provider', model: 'example-model',
    }, { silent: true });
    expect(await screen.findByText('Cedar')).toBeInTheDocument();
    expect(onStageUpdate).toHaveBeenCalledExactlyOnceWith('prose', prose, updatedIssue);
  });

  it('backfills only undescribed, unlocked nouns named in the prose and propagates description gaps', async () => {
    const observatory = { id: 'place-1', name: 'Observatory' };
    const characters = [
      cedar,
      { id: 'char-2', name: 'Flint', locked: true },
      { id: 'char-3', name: 'Willow' },
    ];
    getUniverse.mockResolvedValue({ ...universe, characters, places: [observatory] });
    const prose = {
      ...issue.stages.prose,
      descGaps: { none: [], thin: [{ id: observatory.id, name: observatory.name, kind: 'place' }] },
    };
    const updatedIssue = { ...issue, stages: { prose } };
    describePipelineCanonFromProse.mockResolvedValue({
      issue: updatedIssue,
      universe: { ...universe, characters, places: [{ ...observatory, description: 'A copper dome.' }] },
      report: { filled: 1 },
    });
    const { user, onStageUpdate } = mountStage();

    await user.click(await screen.findByRole('button', { name: 'Describe from prose (1)' }));

    expect(describePipelineCanonFromProse).toHaveBeenCalledWith(issue.id, 'prose', {
      providerOverride: 'series-provider', model: 'series-model',
      targets: [{ id: observatory.id, kind: 'place' }],
    }, { silent: true });
    expect(onStageUpdate).toHaveBeenCalledExactlyOnceWith('prose', prose, updatedIssue);
    expect(await screen.findByDisplayValue('A copper dome.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The manuscript is thin on description for 1 noun.');
    expect(screen.getByRole('button', { name: 'Describe from prose' })).toBeDisabled();
  });

  it('surfaces a failed extraction and preserves prose and existing canon for retry', async () => {
    getUniverse.mockResolvedValue({ ...universe, characters: [cedar] });
    extractPipelineCanonFromScript.mockRejectedValue(new Error('Provider unavailable'));
    const { user, onStageUpdate } = mountStage();

    await user.click(await screen.findByRole('button', { name: 'Extract from prose' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider unavailable');
    expect(screen.getByRole('button', { name: 'Retry extraction' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(cedar.physicalDescription);
    expect(onStageUpdate).toHaveBeenCalledExactlyOnceWith('prose', {
      ...issue.stages.prose,
      canonExtraction: expect.objectContaining({
        status: 'failed',
        error: 'Provider unavailable',
        provider: 'series-provider',
        model: 'series-model',
      }),
    }, undefined);
  });

  it('refines the universe character, then persists an inline canon edit through the patch API', async () => {
    getUniverse.mockResolvedValue({ ...universe, characters: [cedar] });
    const refined = { ...cedar, physicalDescription: 'A scarlet cloak and brass buttons.' };
    refineUniverseCharacter.mockResolvedValue({
      universe: { ...universe, characters: [refined] }, rationale: 'Distinguish silhouette',
    });
    const saved = { ...cedar, physicalDescription: 'A green cloak with brass buttons.' };
    patchUniverseCanonEntry.mockResolvedValue({ entry: saved });
    const { user, onStageUpdate } = mountStage();

    await user.click(await screen.findByRole('button', { name: 'AI differentiate Cedar' }));

    expect(refineUniverseCharacter).toHaveBeenCalledExactlyOnceWith(universe.id, cedar.id, {
      providerId: 'series-provider', model: 'series-model',
    }, { silent: true });
    const description = await screen.findByDisplayValue(refined.physicalDescription);
    await user.clear(description);
    await user.type(description, 'A green cloak.');
    await user.tab();

    expect(patchUniverseCanonEntry).toHaveBeenCalledExactlyOnceWith(
      universe.id, 'character', cedar.id, { physicalDescription: 'A green cloak.' }, { silent: true },
    );
    expect(await screen.findByDisplayValue(saved.physicalDescription)).toBeInTheDocument();
    expect(onStageUpdate).not.toHaveBeenCalled();
  });

  it('queues the selected model for the canon entry and shows its reference when the job completes', async () => {
    getUniverse.mockResolvedValue({ ...universe, characters: [cedar] });
    getSettings.mockResolvedValue({ pipeline: { imageGen: { mode: 'local', modelId: 'model-a', seed: 17 } } });
    listImageModels.mockResolvedValue([{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }]);
    patchSettingsSlice.mockResolvedValue({});
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    const { user } = mountStage();
    await user.click(await screen.findByRole('button', { name: 'Image gen' }));
    const drawer = screen.getByRole('dialog', { name: 'Reference image gen' });
    await within(drawer).findByRole('option', { name: 'Model B' });
    await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Model' }), 'model-b');
    expect(patchSettingsSlice).toHaveBeenCalledWith('pipeline', {
      imageGen: expect.objectContaining({ mode: 'local', modelId: 'model-b' }),
    }, { silent: true });
    await user.click(within(drawer).getByRole('button', { name: 'Close settings' }));
    const renderReference = screen.getByRole('button', { name: 'Render reference for Cedar' });

    await user.click(renderReference);

    expect(generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      mode: 'local', modelId: 'model-b', seed: 17,
      prompt: 'Cedar: A gray cloak.',
      universeRun: expect.objectContaining({
        universeId: universe.id, entryRef: { kind: 'canon', kindKey: 'characters', id: cedar.id },
      }),
    }), { silent: true });
    expect(renderReference).toBeDisabled();
    expect(screen.queryByAltText('Cedar reference')).not.toBeInTheDocument();
    await act(async () => { socket.emit('image-gen:completed', { generationId: 'job-1', filename: 'cedar.png' }); });

    expect(screen.getAllByAltText('Cedar reference').map((image) => image.getAttribute('src')))
      .toContain('/data/images/cedar.png');
    expect(renderReference).toBeEnabled();
  });

  it('leaves the noun and render action intact when image enqueue fails', async () => {
    getUniverse.mockResolvedValue({ ...universe, characters: [cedar] });
    generateImage.mockRejectedValue(new Error('Render queue unavailable'));
    const { user, onStageUpdate } = mountStage();
    const renderReference = await screen.findByRole('button', { name: 'Render reference for Cedar' });

    await user.click(renderReference);

    expect(toast.error).toHaveBeenCalledWith('Render queue unavailable');
    expect(renderReference).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(cedar.physicalDescription);
    expect(onStageUpdate).not.toHaveBeenCalled();
  });
});
