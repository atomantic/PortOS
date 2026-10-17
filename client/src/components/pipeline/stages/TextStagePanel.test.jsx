import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockEventSource, lastEventSource } from '../../../test/mockEventSource';

vi.mock('../../../services/api', () => ({
  generatePipelineStage: vi.fn(),
  getPipelineStageRecovery: vi.fn(async () => ({ recoverable: false, ownership: 'local', live: true })),
  recoverPipelineStage: vi.fn(),
  updatePipelineIssue: vi.fn(),
  restorePipelineStageVersion: vi.fn(),
  pipelineStageProgressUrl: (issueId, stageId) => `/api/pipeline/issues/${issueId}/stages/${stageId}/generate/progress`,
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
import { generatePipelineStage, updatePipelineIssue, getPipelineStageRecovery, recoverPipelineStage } from '../../../services/api';

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

  it('offers explicit legacy takeover, preserves content and unlocks generation after success', async () => {
    getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'legacy-revision', ownership: 'unknown', live: false, recoverable: true });
    const issue = makeIssue({ status: 'generating', output: 'Preserved draft' });
    const stage = { ...issue.stages.idea, status: 'error' };
    recoverPipelineStage.mockResolvedValueOnce({ issue: { ...issue, stages: { idea: stage } }, stage });
    const onStageUpdate = vi.fn();
    const { rerender } = renderPanel(issue, { onStageUpdate });
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Take over stage' }));
    expect(screen.getByText(/may still be running on another machine/)).toBeInTheDocument();
    expect(recoverPipelineStage).toHaveBeenCalledWith('iss-1', 'idea', 'legacy-revision', { silent: true });
    expect(onStageUpdate).toHaveBeenCalledWith('idea', stage, expect.any(Object));
    rerender(<TextStagePanel issue={{ ...issue, stages: { idea: stage } }} stageId="idea" />);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
    expect(screen.getByLabelText('Output')).toHaveValue('Preserved draft');
  });

  it.each(['success', 'failure'])('ignores a pending takeover %s after switching issue and stage', async (outcome) => {
    getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'revision-a', ownership: 'unknown', live: false, recoverable: true });
    let resolveRecovery;
    let rejectRecovery;
    recoverPipelineStage.mockReturnValueOnce(new Promise((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecovery = reject;
    }));
    const issueA = makeIssue({ status: 'generating', output: 'Draft A' });
    const onStageUpdate = vi.fn();
    const { rerender } = renderPanel(issueA, { onStageUpdate });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over stage' }));
    const issueB = { id: 'iss-2', stages: { prose: { status: 'ready', input: '', output: 'Draft B', runHistory: [] } } };
    rerender(<TextStagePanel issue={issueB} stageId="prose" onStageUpdate={onStageUpdate} />);
    expect(screen.getByLabelText('Output')).toHaveValue('Draft B');
    await act(async () => {
      if (outcome === 'success') {
        const stage = { ...issueA.stages.idea, status: 'error' };
        resolveRecovery({ issue: { ...issueA, stages: { idea: stage } }, stage });
      } else {
        rejectRecovery(new Error('Stage A changed'));
      }
    });
    expect(onStageUpdate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Output')).toHaveValue('Draft B');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it.each(['success', 'failure'])('ignores takeover %s after leaving and returning to a replaced stage', async (outcome) => {
    getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'old-revision', ownership: 'unknown', live: false, recoverable: true });
    let resolveRecovery;
    let rejectRecovery;
    recoverPipelineStage.mockReturnValueOnce(new Promise((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecovery = reject;
    }));
    const issueA = makeIssue({ status: 'generating', output: 'Old draft A' });
    const onStageUpdate = vi.fn();
    const { rerender } = renderPanel(issueA, { onStageUpdate });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over stage' }));
    rerender(<TextStagePanel issue={{ id: 'iss-2', stages: { idea: { status: 'ready', output: 'Draft B' } } }} stageId="idea" onStageUpdate={onStageUpdate} />);
    const updatedIssueA = makeIssue({ status: 'ready', output: 'New draft A from another action' });
    rerender(<TextStagePanel issue={updatedIssueA} stageId="idea" onStageUpdate={onStageUpdate} />);
    await act(async () => {
      if (outcome === 'success') {
        const stage = { ...issueA.stages.idea, status: 'error' };
        resolveRecovery({ issue: { ...issueA, stages: { idea: stage } }, stage });
      } else {
        rejectRecovery(new Error('Old takeover failed'));
      }
    });
    expect(onStageUpdate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Output')).toHaveValue('New draft A from another action');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it.each(['success', 'failure'])('ignores takeover %s after the panel unmounts', async (outcome) => {
    getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'old-revision', ownership: 'unknown', live: false, recoverable: true });
    let settle;
    recoverPipelineStage.mockReturnValueOnce(new Promise((resolve, reject) => {
      settle = () => outcome === 'success' ? resolve({ stage: { status: 'error' } }) : reject(new Error('Old takeover failed'));
    }));
    const onStageUpdate = vi.fn();
    const { unmount } = renderPanel(makeIssue({ status: 'generating' }), { onStageUpdate });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over stage' }));
    unmount();
    await act(async () => settle());
    expect(onStageUpdate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('disables takeover while preserving unsaved seed and output edits', async () => {
    getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'legacy-revision', ownership: 'unknown', live: false, recoverable: true });
    renderPanel(makeIssue({ status: 'generating', input: 'Saved seed', output: 'Saved draft' }));
    const takeover = await screen.findByRole('button', { name: 'Take over stage' });
    expect(takeover).toBeEnabled();
    await userEvent.type(screen.getByPlaceholderText('seed…'), ' with unsaved detail');
    await userEvent.type(screen.getByLabelText('Output'), '\nUnsaved second paragraph.');
    expect(takeover).toBeDisabled();
    await userEvent.click(takeover);
    expect(recoverPipelineStage).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('seed…')).toHaveValue('Saved seed with unsaved detail');
    expect(screen.getByLabelText('Output')).toHaveValue('Saved draft\nUnsaved second paragraph.');
  });

  it.each(['A local generation is active.', 'The stage changed. Refresh it before taking over.'])(
    'keeps generation blocked and content intact when takeover is refused: %s', async (message) => {
      getPipelineStageRecovery.mockResolvedValueOnce({ revision: 'shown-revision', ownership: 'unknown', live: false, recoverable: true });
      recoverPipelineStage.mockRejectedValueOnce(new Error(message));
      const onStageUpdate = vi.fn();
      renderPanel(makeIssue({ status: 'generating', output: 'Keep this draft' }), { onStageUpdate });
      await userEvent.click(await screen.findByRole('button', { name: 'Take over stage' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
      expect(onStageUpdate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
      expect(screen.getByLabelText('Output')).toHaveValue('Keep this draft');
    },
  );

  it.each([
    { ownership: 'foreign', live: false, text: /belongs to another machine/ },
    { ownership: 'unknown', live: true, text: /active on this machine/ },
  ])('does not offer recovery for $ownership ownership with live=$live', async ({ ownership, live, text }) => {
    getPipelineStageRecovery.mockResolvedValueOnce({ ownership, live, recoverable: false });
    renderPanel(makeIssue({ status: 'generating' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over stage' })).not.toBeInTheDocument();
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

  it('resume-on-mount: mounting with server-side "generating" status keeps Generate disabled without starting a fresh run', async () => {
    const issue = makeIssue({ status: 'generating' });
    renderPanel(issue);
    await screen.findByText('A generation is active on this machine.');

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

  it('dirty-gate: routes Generate through the confirm row once the draft diverges, and straight through once the saved stage is lifted back in', async () => {
    const issue = makeIssue({ status: 'ready', output: 'Saved idea text.' });
    const savedStage = { status: 'edited', input: '', output: 'Edited idea text.' };
    const savedIssue = { ...issue, stages: { idea: savedStage } };
    updatePipelineIssue.mockResolvedValue(savedIssue);
    generatePipelineStage.mockResolvedValue({ stage: savedStage });

    const { rerender } = renderPanel(issue);
    const generateBtn = screen.getByRole('button', { name: 'Generate' });
    expect(generateBtn).not.toBeDisabled();

    const output = screen.getByPlaceholderText('output…');
    await userEvent.clear(output);
    await userEvent.type(output, 'Edited idea text.');

    // Still clickable — but it asks first instead of firing the generate.
    expect(generateBtn).not.toBeDisabled();
    await userEvent.click(generateBtn);
    expect(await screen.findByRole('button', { name: /Generate & compare/i })).toBeInTheDocument();
    expect(generatePipelineStage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
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
    await userEvent.click(generateBtn);
    await waitFor(() => expect(generatePipelineStage).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Generate & compare/i })).not.toBeInTheDocument();
  });

  describe('regenerate-over-unsaved-edits review (#3398)', () => {
    // Dirties the output editor, then drives the confirm row through to the
    // generate call so the diff review is on screen.
    const generateOverEdits = async ({ incoming, onStageUpdate = () => {} }) => {
      const issue = makeIssue({ status: 'ready', output: 'Saved idea text.' });
      generatePipelineStage.mockResolvedValue({
        stage: { status: 'ready', input: '', output: incoming, runHistory: [] },
      });
      renderPanel(issue, { onStageUpdate });

      const output = screen.getByPlaceholderText('output…');
      await userEvent.clear(output);
      await userEvent.type(output, 'My unsaved edits.');

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await userEvent.click(screen.getByRole('button', { name: /Generate & compare/i }));
      await waitFor(() => expect(generatePipelineStage).toHaveBeenCalled());
      return output;
    };

    it('holds the incoming result in an inline diff instead of replacing the unsaved text', async () => {
      const output = await generateOverEdits({ incoming: 'Freshly generated text.' });

      expect(await screen.findByRole('button', { name: /Use new version/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Keep my edits/i })).toBeInTheDocument();
      // The editor still shows what the user typed, and the diff highlights both
      // sides (word-level runs, so assert on the changed words).
      expect(output).toHaveValue('My unsaved edits.');
      expect(screen.getByText('unsaved')).toBeInTheDocument();
      expect(screen.getByText('Freshly')).toBeInTheDocument();
      // Save is parked until the comparison is resolved.
      expect(screen.getByRole('button', { name: /Save edits/i })).toBeDisabled();
    });

    it('applying the new version replaces the editor text and dismisses the diff', async () => {
      const output = await generateOverEdits({ incoming: 'Freshly generated text.' });

      await userEvent.click(await screen.findByRole('button', { name: /Use new version/i }));

      expect(output).toHaveValue('Freshly generated text.');
      expect(screen.queryByRole('button', { name: /Use new version/i })).not.toBeInTheDocument();
    });

    it('canceling preserves the unsaved edits untouched', async () => {
      const output = await generateOverEdits({ incoming: 'Freshly generated text.' });

      await userEvent.click(await screen.findByRole('button', { name: /Keep my edits/i }));

      expect(output).toHaveValue('My unsaved edits.');
      expect(screen.queryByRole('button', { name: /Keep my edits/i })).not.toBeInTheDocument();
      // Still dirty against the newly persisted output, so Save is live again.
      expect(screen.getByRole('button', { name: /Save edits/i })).not.toBeDisabled();
    });

    it('skips the review when the generated text matches the unsaved edits', async () => {
      const output = await generateOverEdits({ incoming: 'My unsaved edits.' });

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Idea generated'));
      expect(screen.queryByRole('button', { name: /Use new version/i })).not.toBeInTheDocument();
      expect(output).toHaveValue('My unsaved edits.');
    });

    it('reviews edits typed while the generation was in flight', async () => {
      let resolveGenerate;
      generatePipelineStage.mockReturnValue(new Promise((r) => { resolveGenerate = r; }));
      renderPanel(makeIssue({ status: 'ready', output: 'Saved idea text.' }));

      // Clean editor at kickoff, so Generate fires without the confirm row.
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      const output = screen.getByPlaceholderText('output…');
      await userEvent.clear(output);
      await userEvent.type(output, 'Typed mid-run.');

      await act(async () => resolveGenerate({
        stage: { status: 'ready', input: '', output: 'Freshly generated text.', runHistory: [] },
      }));

      expect(await screen.findByRole('button', { name: /Use new version/i })).toBeInTheDocument();
      expect(output).toHaveValue('Typed mid-run.');
    });

    it('drops a result that lands after the panel moved to another record', async () => {
      let resolveGenerate;
      generatePipelineStage.mockReturnValue(new Promise((r) => { resolveGenerate = r; }));
      const onStageUpdate = vi.fn();
      const { rerender } = renderPanel(makeIssue({ status: 'ready', output: 'Saved idea text.' }), { onStageUpdate });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

      // The panel is reused across issues — swap the record mid-run.
      const otherIssue = {
        id: 'iss-2',
        stages: { idea: { status: 'ready', input: '', output: 'Another idea entirely.', runHistory: [] } },
      };
      rerender(
        <TextStagePanel
          issue={otherIssue}
          stageId="idea"
          seedPlaceholder="seed…"
          outputPlaceholder="output…"
          onStageUpdate={onStageUpdate}
        />,
      );

      await act(async () => resolveGenerate({
        stage: { status: 'ready', input: '', output: 'Freshly generated text.', runHistory: [] },
      }));

      expect(screen.queryByRole('button', { name: /Use new version/i })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('output…')).toHaveValue('Another idea entirely.');
      // Lifting it would patch whichever record is on screen now.
      expect(onStageUpdate).not.toHaveBeenCalled();
    });

    it('gates Generate on an in-flight save of the same stage record', async () => {
      updatePipelineIssue.mockReturnValue(new Promise(() => {}));
      renderPanel(makeIssue({ status: 'ready', output: 'Saved idea text.' }));

      // Seed-only edit: the output stays clean, so Generate is otherwise live.
      await userEvent.type(screen.getByPlaceholderText('seed…'), 'A seed.');
      await userEvent.click(screen.getByRole('button', { name: /Save edits/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled());
      expect(generatePipelineStage).not.toHaveBeenCalled();
    });

    it('lifts the generated stage to the parent even while the review is open', async () => {
      const onStageUpdate = vi.fn();
      await generateOverEdits({ incoming: 'Freshly generated text.', onStageUpdate });

      await waitFor(() => expect(onStageUpdate).toHaveBeenCalledWith(
        'idea',
        expect.objectContaining({ output: 'Freshly generated text.' }),
      ));
      expect(await screen.findByRole('button', { name: /Use new version/i })).toBeInTheDocument();
    });
  });

  describe('live generation progress (#3393)', () => {
    beforeEach(() => {
      MockEventSource.reset();
      global.EventSource = MockEventSource;
    });
    afterEach(() => { delete global.EventSource; });

    // A generate call that stays pending so the stream is still "in flight".
    const pendingGenerate = () => {
      let resolve;
      generatePipelineStage.mockReturnValue(new Promise((r) => { resolve = r; }));
      return (stage) => resolve({ stage });
    };

    it('subscribes to the progress stream on Generate and renders the live phase + attempt scores', async () => {
      const finish = pendingGenerate();
      renderPanel(makeIssue());

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await waitFor(() => expect(lastEventSource()).toBeTruthy());
      expect(lastEventSource().url).toBe('/api/pipeline/issues/iss-1/stages/idea/generate/progress');

      act(() => {
        lastEventSource().emit({ type: 'start', stageId: 'idea' });
        lastEventSource().emit({ type: 'phase', phase: 'generate', label: 'Drafting attempt 1 of 2', attempt: 1, attempts: 2 });
      });
      expect(await screen.findByText('Drafting…')).toBeInTheDocument();
      expect(screen.getByText('· attempt 1 of 2')).toBeInTheDocument();

      act(() => {
        lastEventSource().emit({ type: 'attempt', attempt: 1, attempts: 2, runId: 'run-a', qualityScore: 5.2, outputLength: 1200, ms: 4000 });
        lastEventSource().emit({ type: 'attempt', attempt: 2, attempts: 2, runId: 'run-b', qualityScore: 8, outputLength: 1400, ms: 3000 });
        lastEventSource().emit({ type: 'gate', winner: 'run-b', keptScore: 8, ran: 2, attempts: 2, stoppedEarly: false });
      });
      expect(screen.getByText('Attempt 1')).toBeInTheDocument();
      expect(screen.getByText('5.2')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
      expect(screen.getByText('kept')).toBeInTheDocument();
      expect(screen.getByText('rejected')).toBeInTheDocument();

      await act(async () => { finish({ status: 'ready', input: '', output: 'ok', runHistory: [] }); });
      // The stream is torn down once the POST settles, but the scorecard stays.
      await waitFor(() => expect(lastEventSource().closed).toBe(true));
      expect(screen.getByText('Attempt 1')).toBeInTheDocument();
    });

    it('renders an unscored attempt as — rather than 0', async () => {
      pendingGenerate();
      renderPanel(makeIssue());
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await waitFor(() => expect(lastEventSource()).toBeTruthy());

      act(() => {
        lastEventSource().emit({ type: 'attempt', attempt: 1, attempts: 1, runId: 'run-a', qualityScore: null, outputLength: 10, ms: 1000 });
      });
      expect(await screen.findByText('—')).toBeInTheDocument();
    });

    it('still completes generation when the progress stream fails to connect', async () => {
      const stage = { status: 'ready', input: '', output: 'Generated idea text.', runHistory: [] };
      generatePipelineStage.mockResolvedValue({ stage });
      const onStageUpdate = vi.fn();
      renderPanel(makeIssue(), { onStageUpdate });

      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      // The channel dies immediately — generation is unaffected.
      act(() => lastEventSource()?.fail(MockEventSource.CLOSED));

      await waitFor(() => expect(onStageUpdate).toHaveBeenCalledWith('idea', stage));
      expect(toast.success).toHaveBeenCalledWith('Idea generated');
    });
  });
});
