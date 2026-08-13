import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import { StoryStepRunProvider, useStoryStepRun } from './useStoryStepRuns.jsx';

vi.mock('../services/api', () => ({
  storyStepProgressSseUrl: (sessionId, stepId) => `/api/story-builder/${sessionId}/steps/${stepId}/progress`,
}));

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

// Stands in for StepPanel: it is keyed by the active step in the real page, so
// navigating the rail UNMOUNTS it mid-run. That is the bug this hook fixes.
function StepPanel({ stepId, kickoff, onComplete, onError, meta }) {
  const { start, busy, phase, op, meta: runMeta } = useStoryStepRun(stepId);
  return (
    <div>
      <button onClick={() => start('generate', kickoff, { onComplete, onError }, meta)}>run-{stepId}</button>
      <span data-testid={`state-${stepId}`}>{busy ? `busy:${op}:${phase}` : 'idle'}</span>
      <span data-testid={`meta-${stepId}`}>{runMeta?.entryId || 'none'}</span>
    </div>
  );
}

function Harness({ panelProps, sessionId = 's1' }) {
  const [stepId, setStepId] = useState(panelProps.stepId);
  return (
    <StoryStepRunProvider sessionId={sessionId}>
      <button onClick={() => setStepId('other')}>navigate</button>
      <StepPanel key={stepId} {...panelProps} stepId={stepId} />
    </StoryStepRunProvider>
  );
}

const click = (label) => act(() => { screen.getByText(label).click(); });

describe('useStoryStepRuns', () => {
  it('subscribes only after the kickoff resolves, then reports the live phase', async () => {
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete: vi.fn(), onError: vi.fn() }} />);

    click('run-plotArc');
    expect(MockEventSource.instances).toHaveLength(0); // not until the POST lands
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(lastEventSource().url).toBe('/api/story-builder/s1/steps/plotArc/progress');

    act(() => lastEventSource().emit({ runId: 'r1', type: 'progress', label: 'Planning…' }));
    expect(screen.getByTestId('state-plotArc').textContent).toBe('busy:generate:Planning…');
  });

  it('keeps the stream alive and still fires onComplete when the panel unmounts mid-run', async () => {
    const onComplete = vi.fn();
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete, onError: vi.fn() }} />);

    click('run-plotArc');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    click('navigate'); // remounts the panel on another step — the old bug's trigger
    expect(lastEventSource().closed).toBe(false);

    act(() => lastEventSource().emit({ runId: 'r1', type: 'complete', changes: ['a'] }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('restores the run phase and meta when the panel remounts on the same step', async () => {
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    const { rerender } = render(
      <StoryStepRunProvider sessionId="s1">
        <StepPanel stepId="characters" kickoff={kickoff} onComplete={vi.fn()} onError={vi.fn()} meta={{ entryId: 'char-1' }} />
      </StoryStepRunProvider>,
    );
    click('run-characters');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => lastEventSource().emit({ runId: 'r1', type: 'progress', label: 'Refining…' }));

    rerender(
      <StoryStepRunProvider sessionId="s1">
        <div key="remount">
          <StepPanel stepId="characters" kickoff={kickoff} onComplete={vi.fn()} onError={vi.fn()} meta={{ entryId: 'char-1' }} />
        </div>
      </StoryStepRunProvider>,
    );
    expect(screen.getByTestId('state-characters').textContent).toBe('busy:generate:Refining…');
    expect(screen.getByTestId('meta-characters').textContent).toBe('char-1');
  });

  // A replayed terminal frame from the step's PREVIOUS run must never be
  // reported as this run's success. The underlying SSE hook closes the stream on
  // any terminal-typed frame, so the run settles through the lost-connection
  // path instead — an honest failure, not a false "Generated" toast.
  it('never reports a replayed previous-run terminal frame as this run completing', async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r2' });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete, onError }} />);
    click('run-plotArc');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => lastEventSource().emit({ runId: 'r1', type: 'complete' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  it('settles with an error when the stream closes without a terminal frame', async () => {
    const onError = vi.fn();
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete: vi.fn(), onError }} />);
    click('run-plotArc');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => lastEventSource().fail());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toMatch(/Lost connection/);
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  it('reports a kickoff conflict through onError without subscribing', async () => {
    const onError = vi.fn();
    const kickoff = vi.fn().mockResolvedValue({ conflict: true });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete: vi.fn(), onError }} />);
    click('run-plotArc');

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toMatch(/Another operation is already running/);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  it('settles instead of sticking busy when the kickoff returns no run id', async () => {
    const onError = vi.fn();
    const kickoff = vi.fn().mockResolvedValue({});
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete: vi.fn(), onError }} />);
    click('run-plotArc');

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0].message).toMatch(/did not return a run/);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  // A slot stamped with the story it was started under: the reset effect only
  // runs AFTER the render in which sessionId changed, so an unstamped slot would
  // render one frame against the new id and open a stream on the wrong story.
  it('never subscribes another story to a run started on the previous one', async () => {
    const onComplete = vi.fn();
    let resolveKickoff;
    const kickoff = vi.fn(() => new Promise((res) => { resolveKickoff = res; }));
    const { rerender } = render(
      <StoryStepRunProvider sessionId="s1">
        <StepPanel stepId="plotArc" kickoff={kickoff} onComplete={onComplete} onError={vi.fn()} />
      </StoryStepRunProvider>,
    );
    click('run-plotArc');

    rerender(
      <StoryStepRunProvider sessionId="s2">
        <StepPanel stepId="plotArc" kickoff={kickoff} onComplete={onComplete} onError={vi.fn()} />
      </StoryStepRunProvider>,
    );
    await act(async () => { resolveKickoff({ runId: 'r1' }); });

    expect(MockEventSource.instances).toHaveLength(0);
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  it('never re-points a live run\'s stream at a newly-opened story', async () => {
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    const { rerender } = render(
      <StoryStepRunProvider sessionId="s1">
        <StepPanel stepId="plotArc" kickoff={kickoff} onComplete={vi.fn()} onError={vi.fn()} />
      </StoryStepRunProvider>,
    );
    click('run-plotArc');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    rerender(
      <StoryStepRunProvider sessionId="s2">
        <StepPanel stepId="plotArc" kickoff={kickoff} onComplete={vi.fn()} onError={vi.fn()} />
      </StoryStepRunProvider>,
    );
    // The run belongs to s1; no stream may ever open against s2's URL.
    expect(MockEventSource.instances.filter((es) => es.url.includes('/s2/'))).toHaveLength(0);
    expect(screen.getByTestId('state-plotArc').textContent).toBe('idle');
  });

  it('refuses a second kickoff on the same step while one is in flight', async () => {
    const kickoff = vi.fn().mockResolvedValue({ runId: 'r1' });
    render(<Harness panelProps={{ stepId: 'plotArc', kickoff, onComplete: vi.fn(), onError: vi.fn() }} />);
    click('run-plotArc');
    click('run-plotArc');
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(kickoff).toHaveBeenCalledTimes(1);
  });
});
