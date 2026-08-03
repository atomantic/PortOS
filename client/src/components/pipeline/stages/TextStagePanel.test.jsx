import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  generatePipelineStage: vi.fn(),
  updatePipelineIssue: vi.fn(),
  restorePipelineStageVersion: vi.fn(),
  PIPELINE_STAGE_LABELS: { idea: 'Idea', prose: 'Prose', comicScript: 'Comic', teleplay: 'Teleplay' },
  PIPELINE_TEXT_STAGES: ['idea', 'prose', 'comicScript', 'teleplay'],
  PIPELINE_DEFAULT_FORWARD_SOURCE: { prose: ['idea'], comicScript: ['prose'], teleplay: ['prose'] },
  PIPELINE_STAGE_STATUS_LABEL: { empty: 'Not started', generating: 'Generating…', ready: 'Ready', edited: 'Edited' },
  PIPELINE_STAGE_STATUS_COLOR: {},
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import TextStagePanel from './TextStagePanel';
import toast from '../../ui/Toast';
import { generatePipelineStage, updatePipelineIssue } from '../../../services/api';

const makeIssue = (ideaOverrides = {}) => ({
  id: 'iss-1',
  stages: {
    idea: { status: 'empty', input: '', output: '', runHistory: [], ...ideaOverrides },
  },
});

const renderPanel = (issue, extra = {}) => render(
  <TextStagePanel
    issue={issue}
    stageId="idea"
    seedPlaceholder="seed…"
    outputPlaceholder="output…"
    onStageUpdate={() => {}}
    {...extra}
  />,
);

describe('TextStagePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Generate success: calls the generate API with the right shape and reflects the new content once the parent lifts it', async () => {
    const stage = { status: 'ready', input: '', output: 'Generated idea text.', runHistory: [] };
    generatePipelineStage.mockResolvedValue({ stage });
    const onStageUpdate = vi.fn();
    const issue = makeIssue();

    const { rerender } = renderPanel(issue, { onStageUpdate });

    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(generatePipelineStage).toHaveBeenCalledWith(
      'iss-1',
      'idea',
      { seedInput: '', providerId: undefined, model: undefined },
      { silent: true },
    ));
    expect(onStageUpdate).toHaveBeenCalledWith('idea', stage);
    expect(toast.success).toHaveBeenCalledWith('Idea generated');

    // The panel itself doesn't self-update its draft on generate — it relies
    // on the parent lifting `onStageUpdate` back into the `issue` prop.
    rerender(
      <TextStagePanel
        issue={{ ...issue, stages: { idea: stage } }}
        stageId="idea"
        seedPlaceholder="seed…"
        outputPlaceholder="output…"
        onStageUpdate={onStageUpdate}
      />,
    );
    expect(screen.getByPlaceholderText('output…')).toHaveValue('Generated idea text.');
  });

  it('Generate failure: toasts the error and leaves no stale-success state behind', async () => {
    generatePipelineStage.mockRejectedValue(new Error('LLM unavailable'));
    const onStageUpdate = vi.fn();
    renderPanel(makeIssue(), { onStageUpdate });

    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('LLM unavailable'));
    expect(onStageUpdate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('output…')).toHaveValue('');
  });

  it('Save: persists the draft with the right shape and clears the dirty gate once the parent lifts the saved stage', async () => {
    const issue = makeIssue();
    const updatedStage = { status: 'edited', input: '', output: 'New content' };
    const updatedIssue = { ...issue, stages: { idea: updatedStage } };
    updatePipelineIssue.mockResolvedValue(updatedIssue);
    const onStageUpdate = vi.fn();

    const { rerender } = renderPanel(issue, { onStageUpdate });

    await userEvent.type(screen.getByPlaceholderText('output…'), 'New content');
    await userEvent.click(screen.getByRole('button', { name: /Save edits/i }));

    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalledWith('iss-1', {
      stages: { idea: { status: 'edited', input: '', output: 'New content' } },
    }));
    expect(onStageUpdate).toHaveBeenCalledWith('idea', updatedStage, updatedIssue);
    expect(toast.success).toHaveBeenCalledWith('Idea saved');

    rerender(
      <TextStagePanel
        issue={updatedIssue}
        stageId="idea"
        seedPlaceholder="seed…"
        outputPlaceholder="output…"
        onStageUpdate={onStageUpdate}
      />,
    );
    expect(screen.getByRole('button', { name: /Save edits/i })).toBeDisabled();
  });

  it('resume-on-mount: mounting with server-side "generating" status keeps Generate disabled without starting a fresh run', () => {
    const issue = makeIssue({ status: 'generating' });
    renderPanel(issue);

    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(generatePipelineStage).not.toHaveBeenCalled();
  });

  it('resume-on-mount: re-enables once the server-pushed status leaves generating', () => {
    const issue = makeIssue({ status: 'generating' });
    const { rerender } = renderPanel(issue);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();

    const done = { ...issue, stages: { idea: { status: 'ready', input: '', output: 'done', runHistory: [] } } };
    rerender(
      <TextStagePanel
        issue={done}
        stageId="idea"
        seedPlaceholder="seed…"
        outputPlaceholder="output…"
        onStageUpdate={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Generate' })).not.toBeDisabled();
  });

  it('dirty-gate: disables Generate with the "Save or discard" title once the draft diverges, and re-enables once the saved stage is lifted back in', async () => {
    const issue = makeIssue({ status: 'ready', output: 'Saved idea text.' });
    const savedStage = { status: 'edited', input: '', output: 'Edited idea text.' };
    const savedIssue = { ...issue, stages: { idea: savedStage } };
    updatePipelineIssue.mockResolvedValue(savedIssue);

    const { rerender } = renderPanel(issue);
    const generateBtn = screen.getByRole('button', { name: 'Generate' });
    expect(generateBtn).not.toBeDisabled();
    expect(generateBtn).not.toHaveAttribute('title', 'Save or discard your edits first');

    const output = screen.getByPlaceholderText('output…');
    await userEvent.clear(output);
    await userEvent.type(output, 'Edited idea text.');

    expect(generateBtn).toBeDisabled();
    expect(generateBtn).toHaveAttribute('title', 'Save or discard your edits first');

    await userEvent.click(screen.getByRole('button', { name: /Save edits/i }));
    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalled());

    // Saving alone doesn't clear the gate — the panel compares the draft
    // against the `issue` prop's stage, which only updates once the parent
    // lifts `onStageUpdate`'s result back down.
    rerender(
      <TextStagePanel
        issue={savedIssue}
        stageId="idea"
        seedPlaceholder="seed…"
        outputPlaceholder="output…"
        onStageUpdate={() => {}}
      />,
    );
    expect(generateBtn).not.toBeDisabled();
  });
});
