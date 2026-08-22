import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  runModelCapabilityTest: vi.fn(),
  deleteModelCapabilityTest: vi.fn(),
  // The report carries summaries only; the drawer fetches the model output and
  // the agent transcript for the one pairing it opens.
  getModelCapabilityTestResult: vi.fn(async () => ({ output: '', transcript: '' })),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// The live agent transcript arrives on the shared `localLlm:progress` socket
// event; these tests replay frames through the registered handler.
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import { runModelCapabilityTest, deleteModelCapabilityTest, getModelCapabilityTestResult } from '../../services/api';
import socket from '../../services/socket';
import ModelCapabilityTests from './ModelCapabilityTests.jsx';

const TESTS = [
  { id: 'sandbox-repair', label: 'Sandbox repair', capabilities: ['tools'], prefers: ['code'], blurb: 'Fix a broken module in a sandbox.', driver: 'tui', kind: 'agent' },
  { id: 'image-analysis', label: 'Image analysis', capabilities: ['vision'], prefers: [], blurb: 'Describe a fixture image.', driver: 'chat', kind: 'vision' },
  { id: 'story-outline', label: 'Story outline', capabilities: ['chat'], prefers: ['reasoning'], blurb: 'Outline a hero journey.', driver: 'chat', kind: 'text' },
];

const slot = (testId, over = {}) => ({ testId, state: 'applicable', missing: [], reason: null, result: null, ...over });

const model = (over = {}) => ({
  backend: 'ollama',
  runtimeLabel: 'Ollama',
  modelId: 'example-model:7b',
  capabilities: ['chat', 'tools', 'vision'],
  tests: TESTS.map((t) => slot(t.id)),
  verdict: null,
  ...over,
});

const report = (over = {}) => ({
  tests: TESTS,
  testIds: TESTS.map((t) => t.id),
  prompts: {
    'image-analysis': 'Describe everything you can see in this image.',
    'story-outline': 'Outline this as a hero journey in twelve beats.',
    'sandbox-repair': 'Fix cart-totals.mjs so the test passes.',
  },
  models: [model()],
  runtimes: [{ id: 'ollama', label: 'Ollama', endpointRuntime: false, error: null, agentDriver: { available: true, reason: null } }],
  counts: { models: 1, applicable: 3, passed: 0, failed: 0 },
  listErrors: [],
  readError: null,
  ...over,
});

const renderPanel = (props = {}) => render(
  <MemoryRouter initialEntries={['/models/performance']}>
    <ModelCapabilityTests report={report()} loading={false} onReload={vi.fn()} {...props} />
  </MemoryRouter>,
);

/**
 * Replay a server progress frame through the handler the panel registered.
 * Wrapped in `act` because a socket frame drives a state update from outside
 * React's event system — the suite treats an unwrapped one as a hard failure.
 */
const emitFrame = async (frame) => {
  const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')?.[1];
  await act(async () => { handler?.(frame); });
};

beforeEach(() => vi.clearAllMocks());

describe('the matrix', () => {
  it('lists every installed model with the badges it claims', () => {
    renderPanel();
    expect(screen.getByText('example-model:7b')).toBeInTheDocument();
    expect(screen.getByLabelText('Tool use')).toBeInTheDocument();
    expect(screen.getByLabelText('Vision')).toBeInTheDocument();
  });

  it('shows an unclaimed capability as a reason, never as a failure', () => {
    renderPanel({
      report: report({
        models: [model({
          capabilities: ['chat'],
          tests: [
            slot('sandbox-repair', { state: 'not-applicable', missing: ['tools'], reason: 'no tools badge' }),
            slot('image-analysis', { state: 'not-applicable', missing: ['vision'], reason: 'no vision badge' }),
            slot('story-outline'),
          ],
        })],
      }),
    });
    expect(screen.getByText('no tools badge')).toBeInTheDocument();
    expect(screen.getByText('no vision badge')).toBeInTheDocument();
    // A skipped test is not a red verdict and offers no run.
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /not run/i })).toHaveLength(1);
  });

  it('says a test cannot run here when PortOS has no driver for the runtime', () => {
    renderPanel({
      report: report({
        models: [model({ tests: [slot('sandbox-repair', { state: 'unavailable', reason: 'no OpenCode TUI provider is configured for LM Studio' }), slot('image-analysis'), slot('story-outline')] })],
      }),
    });
    expect(screen.getByText(/can.t run here/)).toBeInTheDocument();
  });

  it('renders "capabilities not reported" rather than an empty badge row', () => {
    renderPanel({ report: report({ models: [model({ capabilities: null })] }) });
    expect(screen.getByText('capabilities not reported')).toBeInTheDocument();
  });

  it('summarises a recorded result in the cell', () => {
    renderPanel({
      report: report({
        models: [model({
          tests: [
            slot('sandbox-repair', { result: { verdict: 'passed', summary: 'fixed in 3 tool calls' } }),
            slot('image-analysis', { result: { verdict: 'failed', summary: '1 of 4 required' } }),
            slot('story-outline'),
          ],
        })],
      }),
    });
    expect(screen.getByText('fixed in 3 tool calls')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 required')).toBeInTheDocument();
  });

  it('says so plainly when nothing is installed', () => {
    renderPanel({ report: report({ models: [], counts: { models: 0, applicable: 0, passed: 0, failed: 0 } }) });
    expect(screen.getByText(/no local models are installed/i)).toBeInTheDocument();
  });
});

describe('the run gate', () => {
  it('names the exact prompt before anything is sent', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getAllByRole('button', { name: /not run/i })[1]);

    expect(await screen.findByText('Describe everything you can see in this image.')).toBeInTheDocument();
    // Nothing has been called yet — the gate is the consent step.
    expect(runModelCapabilityTest).not.toHaveBeenCalled();
  });

  it('warns that the claim is unverified on a runtime that reports no capabilities', async () => {
    const user = userEvent.setup();
    renderPanel({
      report: report({
        models: [model({ backend: 'llama', runtimeLabel: 'llama.cpp', capabilities: null, tests: TESTS.map((t) => slot(t.id, { state: 'unknown', reason: 'this runtime reports no capability list' })) })],
      }),
    });
    await user.click(screen.getAllByRole('button', { name: /not run/i })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/lists model ids only/i);
  });

  it('runs only the model and test the gate named', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    runModelCapabilityTest.mockResolvedValue({ verdict: 'passed', summary: '4 of 4 required' });
    renderPanel({ onReload });

    await user.click(screen.getAllByRole('button', { name: /not run/i })[1]);
    await user.click(await screen.findByRole('button', { name: /run image analysis/i }));

    await waitFor(() => expect(runModelCapabilityTest).toHaveBeenCalledTimes(1));
    expect(runModelCapabilityTest.mock.calls[0][0]).toEqual({
      backend: 'ollama', modelId: 'example-model:7b', testId: 'image-analysis',
    });
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });
});

describe('the live run', () => {
  it('streams agent transcript lines as they arrive', async () => {
    const user = userEvent.setup();
    // Never resolves: the run stays in flight so the live view is what renders.
    runModelCapabilityTest.mockImplementation(() => new Promise(() => {}));
    renderPanel();

    await user.click(screen.getAllByRole('button', { name: /not run/i })[0]);
    await user.click(await screen.findByRole('button', { name: /run sandbox repair/i }));

    const target = { scope: 'capability-test', backend: 'ollama', modelId: 'example-model:7b', testId: 'sandbox-repair' };
    await emitFrame({ ...target, event: 'progress', message: 'Sandbox ready — 3 files copied.' });
    await emitFrame({ ...target, event: 'output', line: '● read cart-totals.mjs' });

    expect(await screen.findByText('Sandbox ready — 3 files copied.')).toBeInTheDocument();
    expect(await screen.findByText('● read cart-totals.mjs')).toBeInTheDocument();
  });

  it('ignores frames for a pairing it is not running', async () => {
    const user = userEvent.setup();
    runModelCapabilityTest.mockImplementation(() => new Promise(() => {}));
    renderPanel();

    await user.click(screen.getAllByRole('button', { name: /not run/i })[0]);
    await user.click(await screen.findByRole('button', { name: /run sandbox repair/i }));

    await emitFrame({ scope: 'capability-test', backend: 'ollama', modelId: 'some-other-model', testId: 'sandbox-repair', event: 'output', line: 'from another run' });
    // A model pull streaming on the same socket event must not render here either.
    await emitFrame({ scope: 'model-pull', backend: 'ollama', modelId: 'example-model:7b', event: 'output', line: 'pulling a layer' });

    expect(screen.queryByText('from another run')).not.toBeInTheDocument();
    expect(screen.queryByText('pulling a layer')).not.toBeInTheDocument();
  });
});

describe('a recorded result', () => {
  const withResult = (result) => report({
    models: [model({ tests: [slot('sandbox-repair'), slot('image-analysis', { result }), slot('story-outline')] })],
  });

  const openResult = async (user) => {
    await user.click(screen.getByRole('button', { name: /2 of 4 required/i }));
  };

  const RESULT = {
    verdict: 'partial',
    summary: '2 of 4 required, 1 of 3 bonus',
    ranAt: '2026-08-22T09:00:00.000Z',
    elapsedMs: 4200,
    error: null,
    timings: null,
    detail: {
      verdict: 'partial',
      requiredHit: 2,
      requiredTotal: 4,
      bonusHit: 1,
      bonusTotal: 3,
      required: [
        { id: 'bicycle', label: 'Bicycle', any: ['bicycle', 'bike'], hit: true },
        { id: 'bench', label: 'Bench', any: ['bench'], hit: true },
        { id: 'lamp', label: 'Street lamp', any: ['lamp'], hit: false },
        { id: 'dog', label: 'Dog', any: ['dog'], hit: false },
      ],
      bonus: [
        { id: 'red-bicycle', label: 'Bicycle is red', any: ['red'], hit: true },
        { id: 'blue-bench', label: 'Bench is blue', any: ['blue'], hit: false },
        { id: 'sign-number', label: 'Reads the number 3', any: ['3'], hit: false },
      ],
    },
  };

  it('leads with what the model actually said, fetched for this pairing alone', async () => {
    const user = userEvent.setup();
    getModelCapabilityTestResult.mockResolvedValue({ output: 'A bicycle and a bench at night.', transcript: '' });
    renderPanel({ report: withResult(RESULT) });
    await openResult(user);

    expect(await screen.findByText('A bicycle and a bench at night.')).toBeInTheDocument();
    expect(getModelCapabilityTestResult).toHaveBeenCalledWith(
      'ollama', 'example-model:7b', 'image-analysis', { silent: true },
    );
  });

  it('says the model returned nothing only once the record has actually arrived', async () => {
    const user = userEvent.setup();
    getModelCapabilityTestResult.mockResolvedValue({ output: '', transcript: '' });
    renderPanel({ report: withResult(RESULT) });
    await openResult(user);
    // An empty string is a silent model; "not fetched yet" must not render as one.
    expect(await screen.findByText(/returned no text/i)).toBeInTheDocument();
  });

  it('separates required from bonus, and says bonus cannot fail a run', async () => {
    const user = userEvent.setup();
    renderPanel({ report: withResult(RESULT) });
    await openResult(user);
    await user.click(await screen.findByRole('tab', { name: /checks/i }));

    expect(screen.getByText(/2 of 4 — all needed to pass/i)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 — detail work, never fails a run/i)).toBeInTheDocument();
    // Two required hits plus one bonus hit — a bonus miss is styled as a muted
    // skip, never as the red X a required miss gets.
    expect(screen.getAllByLabelText('found')).toHaveLength(3);
    expect(screen.getAllByLabelText('not found')).toHaveLength(4);
  });

  it('discards a result and refreshes rather than leaving a stale row', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    deleteModelCapabilityTest.mockResolvedValue({ success: true });
    renderPanel({ report: withResult(RESULT), onReload });

    await openResult(user);
    await user.click(await screen.findByRole('button', { name: /discard this result/i }));

    await waitFor(() => expect(deleteModelCapabilityTest).toHaveBeenCalledWith(
      'ollama', 'example-model:7b', 'image-analysis', { silent: true },
    ));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('shows a mid-run error beside the score instead of replacing it', async () => {
    const user = userEvent.setup();
    getModelCapabilityTestResult.mockResolvedValue({ output: 'A bicycle and a bench at night.', transcript: '' });
    renderPanel({ report: withResult({ ...RESULT, error: 'Timed out after 300000ms' }) });
    await openResult(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Timed out after 300000ms');
    expect(await screen.findByText('A bicycle and a bench at night.')).toBeInTheDocument();
  });
});

describe('running everything that applies to one model', () => {
  it('offers only the runnable tests, and says how many before the click', () => {
    renderPanel({
      report: report({
        models: [model({
          tests: [
            slot('sandbox-repair', { state: 'not-applicable', reason: 'no tools badge' }),
            slot('image-analysis'),
            slot('story-outline'),
          ],
        })],
      }),
    });
    expect(screen.getByRole('button', { name: /run 2/i })).toBeInTheDocument();
  });

  it('runs them one after another rather than all at once', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    runModelCapabilityTest.mockImplementation(async ({ testId }) => ({ testId, verdict: 'passed', summary: 'ok' }));
    renderPanel({ onReload });

    await user.click(screen.getByRole('button', { name: /run 3/i }));

    await waitFor(() => expect(runModelCapabilityTest).toHaveBeenCalledTimes(3));
    expect(runModelCapabilityTest.mock.calls.map(([payload]) => payload.testId))
      .toEqual(['sandbox-repair', 'image-analysis', 'story-outline']);
    // One refresh at the end, not one per test.
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('stops the whole queue when a test fails rather than pressing on', async () => {
    const user = userEvent.setup();
    runModelCapabilityTest.mockRejectedValueOnce(new Error('llama.cpp is not reachable'));
    renderPanel();

    await user.click(screen.getByRole('button', { name: /run 3/i }));

    await waitFor(() => expect(runModelCapabilityTest).toHaveBeenCalledTimes(1));
    // Minutes of queued work must not run on after the user has been told the
    // runtime is down.
    expect(runModelCapabilityTest).not.toHaveBeenCalledTimes(2);
  });

  it('hides the control for a model no test applies to', () => {
    renderPanel({
      report: report({
        models: [model({
          capabilities: [],
          tests: TESTS.map((t) => slot(t.id, { state: 'not-applicable', reason: 'no badge' })),
        })],
      }),
    });
    expect(screen.queryByRole('button', { name: /^run \d/i })).not.toBeInTheDocument();
  });
});
