import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { typeSettled } from '../../../test/settledInput';

vi.mock('../../../services/api', () => ({
  submitCosAgentFeedback: vi.fn(),
  sendCosAgentBtw: vi.fn(),
  getCosAgent: vi.fn(),
  getCosAgentPrompt: vi.fn(),
  getCosAgentStats: vi.fn(() => new Promise(() => {})),
  addCosTask: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const copyToClipboard = vi.fn();
vi.mock('../../../lib/clipboard', () => ({
  copyToClipboard: (...args) => copyToClipboard(...args),
}));

import * as api from '../../../services/api';
import AgentCard from './AgentCard';

const agent = {
  id: 'agent-example',
  taskId: 'task-example',
  status: 'completed',
  startedAt: '2026-07-13T09:00:00.000Z',
  completedAt: '2026-07-13T10:00:00.000Z',
  metadata: { taskDescription: 'Example task', taskType: 'user' },
  result: { success: true, duration: 3600000 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentCard runtime presentation', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');
  const runningAt = (elapsedMs, metadata = {}) => ({
    ...agent,
    status: 'running',
    startedAt: new Date(now.getTime() - elapsedMs).toISOString(),
    completedAt: null,
    metadata: { ...agent.metadata, ...metadata },
    result: null,
  });
  const durationHistory = {
    'user-task': { avgDurationMs: 45_000, p80DurationMs: 60_000, completed: 8 },
    _overall: { avgDurationMs: 90_000, p80DurationMs: 120_000, completed: 20 },
  };

  it.each([
    ['before the estimate', 30_000, '50% complete', '~30s left', 'ETA: ~30s'],
    ['exactly at the estimate', 60_000, '99% complete', '+0s', '+0s over estimate'],
    ['after the estimate', 75_000, '99% complete', '+15s', '+15s over estimate'],
  ])('renders distinct inline and footer ETA text %s', (_label, elapsedMs, progress, inlineEta, footerEta) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    render(
      <MemoryRouter>
        <AgentCard agent={runningAt(elapsedMs)} durations={durationHistory} />
      </MemoryRouter>
    );

    expect(screen.getByText(progress)).toBeInTheDocument();
    expect(screen.getByText(inlineEta)).toHaveClass('font-mono');
    expect(screen.getByText(footerEta)).toHaveClass('font-medium');
  });

  it('renders elapsed time without ETA or progress when duration history is absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    render(<MemoryRouter><AgentCard agent={runningAt(30_000)} /></MemoryRouter>);

    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.queryByText(/complete$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
  });

  it.each([
    ['type P80', 30_000, durationHistory, '50% complete', /Based on 8 completed user-task tasks \(avg: 45s, est: 1m 0s\)/],
    ['type average', 60_000, { 'user-task': { avgDurationMs: 60_000, completed: 3 } }, '99% complete', /Based on 3 completed user-task tasks \(avg: 1m 0s, est: 1m 0s\)/],
    ['overall P80', 60_000, { _overall: durationHistory._overall }, '50% complete', /Based on 20 completed all tasks tasks \(avg: 1m 30s, est: 2m 0s\)/],
  ])('uses the %s duration fallback', (_label, elapsedMs, durations, progress, title) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    render(
      <MemoryRouter>
        <AgentCard agent={runningAt(elapsedMs)} durations={durations} />
      </MemoryRouter>
    );

    expect(screen.getByText(progress)).toBeInTheDocument();
    expect(screen.getByTitle(title)).toBeInTheDocument();
  });

  it('preserves duration and completion visibility across running, paused, and completed states', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const runningAgent = runningAt(30_000);
    const { rerender } = render(
      <MemoryRouter><AgentCard agent={runningAgent} durations={durationHistory} /></MemoryRouter>
    );
    expect(screen.getByText('50% complete')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();

    rerender(
      <MemoryRouter><AgentCard agent={{ ...runningAgent, status: 'paused' }} paused durations={durationHistory} /></MemoryRouter>
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/complete$/)).not.toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();

    rerender(
      <MemoryRouter><AgentCard agent={agent} completed durations={durationHistory} /></MemoryRouter>
    );
    expect(screen.getByText('1h 0m')).toBeInTheDocument();
    expect(screen.queryByText(/complete$/)).not.toBeInTheDocument();
    expect(screen.getByTitle((value) => value.includes('2026'))).toBeInTheDocument();
  });

  it('suppresses prompt access for remote cards while preserving the live shell destination', () => {
    render(
      <MemoryRouter>
        <AgentCard
          agent={runningAt(30_000, { executionMode: 'tui', tuiSessionId: 'sess-abcdef123' })}
          remote
        />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: 'Prompt' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Shell/ })).toHaveAttribute('href', '/shell?session=sess-abcdef123');
  });

  it('distinguishes a live process, a zombie, and missing process stats', async () => {
    const runningAgent = { ...runningAt(30_000), pid: 4242 };
    api.getCosAgentStats.mockResolvedValueOnce({ active: true, pid: 4242, state: 'running', cpu: 12.3, memoryMb: 64 });
    const { unmount } = render(<MemoryRouter><AgentCard agent={runningAgent} /></MemoryRouter>);
    expect(await screen.findByText('12.3%')).toBeInTheDocument();
    expect(screen.getByText('64MB')).toBeInTheDocument();
    expect(screen.queryByText('ZOMBIE')).not.toBeInTheDocument();
    unmount();

    api.getCosAgentStats.mockResolvedValueOnce({ active: false, pid: 4242 });
    const zombie = render(<MemoryRouter><AgentCard agent={runningAgent} /></MemoryRouter>);
    expect(await screen.findByText('ZOMBIE')).toBeInTheDocument();
    zombie.unmount();

    api.getCosAgentStats.mockResolvedValueOnce(null);
    render(<MemoryRouter><AgentCard agent={runningAgent} /></MemoryRouter>);
    await waitFor(() => expect(api.getCosAgentStats).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('ZOMBIE')).not.toBeInTheDocument();
    expect(screen.queryByText(/PID 4242/)).not.toBeInTheDocument();
  });
});

describe('AgentCard feedback', () => {
  it('hides the rating UI for a completed scheduled/autopilot agent (taskType internal)', () => {
    const internalAgent = {
      ...agent,
      metadata: { ...agent.metadata, taskType: 'internal' },
    };

    render(
      <MemoryRouter>
        <AgentCard agent={internalAgent} completed />
      </MemoryRouter>
    );

    expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument();
  });

  it('uses the archived scheduled type for a running agent ETA', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const runningAgent = {
      ...agent,
      status: 'running',
      startedAt: '2026-07-13T09:59:00.000Z',
      completedAt: null,
      metadata: {
        taskDescription: 'Fix the security configuration',
        taskType: 'internal',
        taskAnalysisType: 'security',
      },
    };
    const durations = {
      'self-improve:security': { avgDurationMs: 600000, p80DurationMs: 600000, completed: 5 },
      _overall: { avgDurationMs: 1000, p80DurationMs: 1000, completed: 20 },
    };

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} durations={durations} />
      </MemoryRouter>
    );

    expect(screen.getByText('10% complete')).toBeInTheDocument();
  });

  it('returns the updated agent to its parent after a successful rating', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' },
    };
    const onFeedbackChange = vi.fn();
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed onFeedbackChange={onFeedbackChange} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Mark as helpful' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: undefined },
      { silent: true }
    );
    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(updatedAgent));
  });

  it('records a negative rating with the detail needed to improve future work', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: {
        rating: 'negative',
        comment: 'The implementation did not include tests.',
        submittedAt: '2026-07-13T12:00:00.000Z'
      }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback comment' }));
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), updatedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Needs work' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'negative', comment: updatedAgent.feedback.comment },
      { silent: true }
    );
  });

  it('lets a quick rating receive a follow-up detail', async () => {
    const user = userEvent.setup();
    const ratedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' }
    };
    const detailedAgent = {
      ...ratedAgent,
      feedback: { ...ratedAgent.feedback, comment: 'The focused test coverage was useful.' }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: detailedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={ratedAgent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback detail' }));
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), detailedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Save detail' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: detailedAgent.feedback.comment },
      { silent: true }
    );
  });
});

describe('AgentCard finish action', () => {
  it('sends the finish-and-sentinel message from an active Claude TUI card', async () => {
    const user = userEvent.setup();
    const runningAgent = {
      ...agent,
      status: 'running',
      completedAt: null,
      metadata: { ...agent.metadata, executionMode: 'tui', tuiKind: 'claude' },
    };
    api.sendCosAgentBtw.mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Finish work and write sentinel' }));

    expect(api.sendCosAgentBtw).toHaveBeenCalledWith(
      runningAgent.id,
      'Finish work and write sentinel.',
      { silent: true }
    );
  });

  it('does not show the finish action for inactive cards', () => {
    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: 'Finish work and write sentinel' })).not.toBeInTheDocument();
  });
});

describe('AgentCard agent ID', () => {
  it.each([
    ['active', { ...agent, status: 'running', completedAt: null }],
    ['historical', agent],
  ])('copies the full ID from the %s card', async (_label, cardAgent) => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AgentCard agent={cardAgent} completed={cardAgent.status === 'completed'} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Copy agent ID' }));

    expect(copyToClipboard).toHaveBeenCalledWith(cardAgent.id, 'Agent ID copied to clipboard');
  });
});

describe('AgentCard responsive header', () => {
  it('keeps the identity and actions rails flexible on narrow cards', () => {
    const onDelete = vi.fn();
    const onResume = vi.fn();

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed onDelete={onDelete} onResume={onResume} />
      </MemoryRouter>
    );

    const actions = screen.getByRole('button', { name: 'Show' }).parentElement;
    const identity = actions.previousElementSibling;

    expect(identity).toHaveClass('basis-0', 'sm:basis-64');
    expect(screen.getByText(agent.id)).toHaveClass('min-w-0');
    expect(actions).toHaveClass('ml-0', 'sm:ml-auto');
  });
});

describe('AgentCard transcript truncation (#3498)', () => {
  it('says the transcript was clipped when the server returns a capped tail', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'last line', timestamp: agent.completedAt }],
      outputTruncated: true,
      outputTotalBytes: 12 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(await screen.findByText(/Showing the last 1 line —/)).toBeInTheDocument();
    expect(screen.getByText(/12 MB/)).toBeInTheDocument();
  });

  it('still reports the clip when the tail window yielded no renderable lines', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [],
      outputTruncated: true,
      outputTotalBytes: 8 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    // "No output captured" would call a multi-MB log empty.
    expect(await screen.findByText(/no readable lines/)).toBeInTheDocument();
    expect(screen.queryByText('No output captured')).not.toBeInTheDocument();
  });

  it('stays quiet when the whole transcript fit under the cap', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'only line', timestamp: agent.completedAt }],
      outputTruncated: false,
      outputTotalBytes: 10,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    await waitFor(() => expect(api.getCosAgent).toHaveBeenCalledWith(agent.id));
    expect(screen.queryByText(/Showing the last/)).not.toBeInTheDocument();
  });
});

describe('AgentCard kill confirmation (#4034)', () => {
  it('requires confirmation before calling onKill', async () => {
    const user = userEvent.setup();
    const onKill = vi.fn().mockResolvedValue(true);
    const runningAgent = {
      ...agent,
      status: 'running',
      completedAt: null,
    };

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} onKill={onKill} />
      </MemoryRouter>
    );

    // Clicking Kill should show confirmation prompt and NOT call onKill immediately
    await user.click(screen.getByRole('button', { name: 'Force kill agent (SIGKILL)' }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.getByText('Kill?')).toBeInTheDocument();

    // Clicking Cancel disarms confirmation state
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.queryByText('Kill?')).not.toBeInTheDocument();

    // Re-arm and click Confirm
    await user.click(screen.getByRole('button', { name: 'Force kill agent (SIGKILL)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onKill).toHaveBeenCalledWith(runningAgent.id);
  });
});


describe('AgentCard task description (#4170)', () => {
  // jsdom reports 0 for both scrollHeight and clientHeight, so nothing measures
  // as overflowing unless we force it.
  const forceOverflow = () =>
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

  afterEach(() => vi.restoreAllMocks());

  it('caps a long description behind an accessible Show more toggle', async () => {
    const user = userEvent.setup();
    forceOverflow();

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    const box = document.getElementById(`agent-desc-${agent.id}`);
    expect(box).toHaveClass('overflow-hidden');

    // The bespoke implementation this replaced carried no aria wiring at all.
    const toggle = screen.getByRole('button', { name: /Show more/ });
    expect(toggle).toHaveAttribute('aria-controls', `agent-desc-${agent.id}`);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(box).not.toHaveClass('overflow-hidden');
    expect(screen.getByRole('button', { name: /Show less/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers no toggle for a description that fits', () => {
    // The replaced implementation gated on `text.length > 200`, so a 201-char
    // description that fit in the cap still rendered a no-op "Show more".
    render(
      <MemoryRouter>
        <AgentCard agent={{ ...agent, metadata: { ...agent.metadata, taskDescription: 'x'.repeat(300) } }} completed />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });
});

describe('AgentCard missing shell explanation', () => {
  const running = (metadata) => ({
    ...agent,
    status: 'running',
    completedAt: null,
    metadata: { ...agent.metadata, ...metadata },
  });

  const renderCard = (a) => render(
    <MemoryRouter>
      <AgentCard agent={a} />
    </MemoryRouter>
  );

  it('says why a public-review stage has no shell instead of leaving the card silent', () => {
    // A tool-free stage — or an actions stage on a provider with no attachable
    // sandbox recipe — runs headless even on a TUI provider, so the "Open
    // Shell" link never appears. Silence made a slow run look wedged with
    // nowhere to look.
    renderCard(running({ publicReviewPosture: 'sandboxed-actions', executionMode: 'direct' }));

    expect(screen.queryByText('Open Shell')).not.toBeInTheDocument();
    expect(screen.getByText('No shell')).toBeInTheDocument();
    expect(screen.getByTitle(/this public-review stage runs headless/)).toBeInTheDocument();
  });

  it('keeps the shell link on an attachable sandboxed-actions run', () => {
    // Stage 3 on a TUI provider whose vendor declares an attachable recipe DOES
    // get a PTY (#6062) — the chip above must not fire on it, or the card would
    // claim there is no shell while linking to one.
    renderCard(running({
      publicReviewPosture: 'sandboxed-actions',
      executionMode: 'tui',
      tuiSessionId: 'sess-6062',
    }));

    expect(screen.queryByText('No shell')).not.toBeInTheDocument();
  });

  it('stays silent on an attachable public-review run that has not registered its session yet', () => {
    // The startup window an attachable Stage 3 now passes through: `executionMode`
    // is already 'tui' but `tuiSessionId` has not landed. Gating on the session id
    // alone made the card assert the stage runs headless for those seconds, then
    // swap the claim for an "Open Shell" link — a false diagnostic, and a worse
    // one if the PTY is merely slow to attach.
    renderCard(running({
      publicReviewPosture: 'sandboxed-actions',
      executionMode: 'tui',
      phase: 'initializing',
    }));

    expect(screen.queryByText('No shell')).not.toBeInTheDocument();
  });

  it('stays silent on a TUI run that has not registered its session yet', () => {
    // `executionMode` is stamped at registration but `tuiSessionId` only lands
    // once the PTY attaches, so every healthy TUI spawn passes through this
    // state — a chip here would put the "looks wedged" noise straight back.
    renderCard(running({ executionMode: 'tui', phase: 'initializing' }));

    expect(screen.queryByText('No shell')).not.toBeInTheDocument();
  });

  it('adds no chip to an ordinary headless CLI agent — none was ever expected', () => {
    renderCard(running({ executionMode: 'direct' }));

    expect(screen.queryByText('No shell')).not.toBeInTheDocument();
  });

  it('links to the live shell, with no explanation chip, once a session exists', () => {
    renderCard(running({ executionMode: 'tui', tuiSessionId: 'sess-abcdef123' }));

    expect(screen.getByText('Open Shell')).toBeInTheDocument();
    expect(screen.queryByText('No shell')).not.toBeInTheDocument();
  });

  // #6117: a ~100K-token public-review envelope aimed at a model server on this
  // box spends minutes in prefill before the child emits its first line. The
  // card showed a running agent with no output and no reason for it.
  it('explains a long silent prefill and names the raised run estimate', () => {
    renderCard(running({
      executionMode: 'direct',
      localPromptBudget: {
        endpoint: 'localhost:18020',
        promptTokens: 100_000,
        prefillMs: 9 * 60_000,
        baseDurationMs: 13 * 60_000,
        expectedDurationMs: 22 * 60_000,
        longPrefill: true,
      },
    }));

    expect(screen.getByText(/Long prefill/)).toBeInTheDocument();
    expect(screen.getByTitle(/100,000 tokens/)).toBeInTheDocument();
    expect(screen.getByTitle(/duration estimate was raised/)).toBeInTheDocument();
  });

  it('stays silent when the prefill is short or the run is not on a local endpoint', () => {
    // An absent budget is "no estimate" (a cloud run, or a record written before
    // the stamp existed) — never "instant". Neither may render the chip.
    renderCard(running({
      executionMode: 'direct',
      localPromptBudget: { endpoint: 'localhost:11434', promptTokens: 2_000, prefillMs: 16_667, longPrefill: false },
    }));
    expect(screen.queryByText(/Long prefill/)).not.toBeInTheDocument();

    cleanup();
    renderCard(running({ executionMode: 'direct' }));
    expect(screen.queryByText(/Long prefill/)).not.toBeInTheDocument();
  });
});

// #5994: the goal-fidelity verdict — whether the run built what the task asked
// for, which no quality reviewer can answer because none of them see the request.
describe('AgentCard goal fidelity', () => {
  const withReview = (goalFidelity) => ({ ...agent, result: { ...agent.result, goalFidelity } });

  it('queues an isolated investigation with the original prompt and app, then links to the task', async () => {
    api.getCosAgentPrompt.mockResolvedValue({ prompt: 'Resolve issue #123 acceptance criteria' });
    api.addCosTask.mockResolvedValue({ id: 'task-investigation', approvalRequired: false });
    render(<MemoryRouter><AgentCard agent={{ ...withReview({ verdict: 'rethink', missing: ['Example gap'] }),
      metadata: { ...agent.metadata, taskApp: 'example-app' } }} completed /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'Investigate findings' }));
    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledWith(expect.objectContaining({
      app: 'example-app', type: 'user', isInvestigation: true,
      prompt: expect.stringContaining('Resolve issue #123 acceptance criteria'),
    }), { silent: true }));
    expect(api.addCosTask.mock.calls[0][0].prompt).toContain('Example gap');
    expect(await screen.findByRole('link', { name: 'View queued investigation' })).toHaveAttribute('href', '/cos/tasks?task=task-investigation&source=user');
    expect(screen.queryByRole('button', { name: 'Investigate findings' })).not.toBeInTheDocument();
  });

  it('keeps prompt retrieval failures visible and permits retry without queuing incomplete context', async () => {
    api.getCosAgentPrompt.mockRejectedValue(new Error('Prompt unavailable'));
    render(<MemoryRouter><AgentCard agent={withReview({ verdict: 'fix-first' })} completed /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'Investigate findings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt unavailable');
    expect(api.addCosTask).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Investigate findings' })).toBeEnabled();
  });

  it('does not dispatch remote findings into the local repository', () => {
    render(<MemoryRouter><AgentCard agent={withReview({ verdict: 'rethink' })} completed remote /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Investigate findings' })).not.toBeInTheDocument();
  });

  it('names the missing and unrequested work behind a rethink verdict', () => {
    render(
      <MemoryRouter>
        <AgentCard agent={withReview({
          verdict: 'rethink',
          missing: ['the retry backoff'],
          unrequested: ['an unrelated logging refactor'],
          evidence: 'no tests were run',
          model: 'example-model',
        })} completed />
      </MemoryRouter>
    );

    expect(screen.getByText(/Does not deliver the objective/)).toBeInTheDocument();
    expect(screen.getByText('the retry backoff')).toBeInTheDocument();
    expect(screen.getByText('an unrelated logging refactor')).toBeInTheDocument();
    expect(screen.getByText('no tests were run')).toBeInTheDocument();
  });

  it('shows a clean ship verdict, and renders nothing at all for a run the gate never judged', () => {
    const { unmount } = render(
      <MemoryRouter>
        <AgentCard agent={withReview({ verdict: 'ship', missing: [], unrequested: [], evidence: '' })} completed />
      </MemoryRouter>
    );
    expect(screen.getByText(/Delivers the objective/)).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Goal fidelity/)).not.toBeInTheDocument();
  });
});

// A claim run works in a `claim/<item>` worktree that the claim command creates
// itself; CoS keeps useWorktree/openPR off only so it does not nest a second
// worktree around it. Reading that false/false as "coding on main" made every
// issue claim from the app Issues page badge itself `main` while it was in fact
// on an isolated branch.
describe('AgentCard branch posture badges', () => {
  const renderWithMetadata = (metadata) => render(
    <MemoryRouter>
      <AgentCard agent={{ ...agent, metadata: { ...agent.metadata, ...metadata } }} completed />
    </MemoryRouter>
  );

  // The load-bearing case for already-archived runs: every claim agent spawned
  // before the server projection was corrected has BOTH flags frozen true in its
  // metadata, so the card has to settle the contradiction on read or those cards
  // wear two conflicting branch badges at once.
  it('suppresses the main badge on a claim run whose stored metadata still says it', () => {
    renderWithMetadata({ configClaimFlow: true, configUseWorktree: false, configCodingOnMain: true });

    expect(screen.getByText('Claim WT')).toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  // Same stale-record problem, other non-committing posture: a read-only run is
  // denied a worktree on purpose and commits nothing, so the warning is false.
  it('badges a read-only run as read-only rather than as coding on main', () => {
    renderWithMetadata({ configReadOnly: true, configUseWorktree: false, configCodingOnMain: true });

    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  // The control. Without it every assertion above is satisfied by deleting the
  // main badge outright.
  it('still badges a genuine commit-to-main run as main', () => {
    renderWithMetadata({ configClaimFlow: false, configUseWorktree: false, configCodingOnMain: true });

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.queryByText('Claim WT')).not.toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
  });
});
