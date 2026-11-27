import socket from '../services/socket';
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
const socketEvent = event => { for (const [name, handler] of socket.on.mock.calls) if (name === event) handler({}); };
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiLocalLlm.js', () => ({
  getLocalLlmStatus: vi.fn(),
  getLocalRuntimeModels: vi.fn(),
  getLocalLlmCatalog: vi.fn(),
  getLoadedLlmModels: vi.fn(),
  streamLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../components/ui/Toast');

import LocalLlmPlayground from './LocalLlmPlayground';
import {
  getLoadedLlmModels,
  getLocalLlmCatalog,
  getLocalLlmStatus,
  getLocalRuntimeModels,
  streamLocalLlmTest,
  compareLocalLlmModels,
} from '../services/apiLocalLlm.js';

const renderPlayground = (entry = '/local-llm/playground?backend=ollama&model=command-r-plus%3A104b') => render(
  <MemoryRouter initialEntries={[entry]}>
    <LocalLlmPlayground />
  </MemoryRouter>,
);

const modelsToggle = () => screen.getByRole('button', { name: /Change models|Hide models/ });
// The narrow disclosure hides its panel with Tailwind's `hidden` class rather
// than unmounting it (the same panel is the permanent xl+ sidebar), so the
// collapsed state is read off the class — jsdom loads no stylesheet, so a
// visibility query would report it visible either way.
const modelsPanelCollapsed = () => document.getElementById('local-llm-models').className.includes('hidden');
const advancedToggle = () => screen.getByRole('button', { name: /Advanced options/ });

beforeEach(() => {
  vi.clearAllMocks();
  getLocalLlmStatus.mockResolvedValue({
    backend: 'ollama',
    ollama: {
      models: [
        {
          id: 'command-r-plus:104b',
          name: 'command-r-plus:104b',
          size: 59 * 1024 ** 3,
          params: '104B',
          quantization: null,
          family: 'command-r',
        },
      ],
    },
    lmstudio: { models: [] },
  });
  getLoadedLlmModels.mockResolvedValue({ ollama: [] });
  getLocalRuntimeModels.mockResolvedValue({ runtimes: [] });
  getLocalLlmCatalog.mockResolvedValue({
    backend: 'ollama',
    models: [
      {
        id: 'command-r-plus:104b',
        name: 'Command R+ 104B',
        category: 'chat',
        params: '104B',
        size: '59 GB',
        family: 'command-r',
        description: 'Cohere long-context model tuned for RAG and dialogue.',
        capabilities: ['chat', 'tools', 'multilingual'],
      },
    ],
  });
});

// The audited fold regression (#7232): the model inventory rendered expanded
// ahead of the task, and the optional tuning fields sat between the prompt and
// the Run button. jsdom can't measure a fold, so these pin the two structural
// facts that produced it — what is disclosed by default, and what order the
// prompt, the run action, and the optional fields appear in.
describe('LocalLlmPlayground task order', () => {
  it('collapses the inventory and renders Run chat before the optional tuning fields', async () => {
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    // A valid target is selected, so the inventory is disclosed, not expanded —
    // and the collapsed header still names what is selected.
    expect(modelsToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(modelsPanelCollapsed()).toBe(true);
    expect(modelsToggle().textContent).toContain('command-r-plus:104b');

    // The tuning fields are behind Advanced options, so nothing optional sits
    // between the prompt and the action the user came for.
    expect(screen.queryByLabelText('System prompt')).toBeNull();
    expect(screen.queryByLabelText('Temperature')).toBeNull();

    const prompt = screen.getByLabelText('Prompt');
    const run = screen.getByRole('button', { name: 'Run chat' });
    const advanced = advancedToggle();
    expect(prompt.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(run.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays collapsed when the first model is auto-selected from a URL carrying no target', async () => {
    // The ⌘K / sidebar entry path: no backend+model params, so the selection is
    // empty on the render where loading finishes and the auto-select effect
    // fills it in the same flush. Keying the disclosure off that momentarily
    // empty selection would leave the inventory expanded here — the exact
    // above-the-fold regression being fixed.
    renderPlayground('/local-llm/playground');

    await waitFor(() => expect(modelsToggle().textContent).toContain('command-r-plus:104b'));
    expect(modelsToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(modelsPanelCollapsed()).toBe(true);
    expect(screen.getByRole('button', { name: 'Run chat' }).disabled).toBe(false);
  });

  it('keeps the selection and the prompt text across opening and closing the picker', async () => {
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a custom prompt' } });

    fireEvent.click(modelsToggle());
    expect(modelsToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(modelsPanelCollapsed()).toBe(false);

    fireEvent.click(modelsToggle());
    expect(modelsToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Prompt').value).toBe('a custom prompt');
    expect(modelsToggle().textContent).toContain('command-r-plus:104b');
    expect(screen.getByRole('button', { name: 'Run chat' }).disabled).toBe(false);
  });

  it('preserves advanced values across the disclosure and a mode switch, and summarizes them while collapsed', async () => {
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.click(advancedToggle());
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.9' } });
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'be terse' } });

    // Collapsed, the header reports what is out of sight so a set system prompt
    // or a stale temperature can't silently shape the run.
    fireEvent.click(advancedToggle());
    expect(advancedToggle().textContent).toContain('system prompt set');
    expect(advancedToggle().textContent).toContain('temp 0.9');
    expect(advancedToggle().textContent).toContain('1000 tokens');

    // Compare mode adds the execution mode to both the summary and the panel,
    // and the values the user already set survive the switch.
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    expect(advancedToggle().textContent).toContain('round robin');
    fireEvent.click(advancedToggle());
    expect(screen.getByLabelText('Temperature').value).toBe('0.9');
    expect(screen.getByLabelText('System prompt').value).toBe('be terse');
    expect(screen.getByLabelText('Execution')).toBeTruthy();
  });

  it('exposes the compare count and Run comparison without opening the inventory', async () => {
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    expect(screen.getByRole('tablist', { name: 'Playground mode' })).toBeInTheDocument();
    const chat = screen.getByRole('tab', { name: 'Chat' });
    const compare = screen.getByRole('tab', { name: 'Compare' });
    expect(chat).toHaveAttribute('tabindex', '0');
    expect(compare).toHaveAttribute('tabindex', '-1');

    chat.focus();
    fireEvent.keyDown(chat, { key: 'ArrowRight' });

    expect(compare).toHaveFocus();
    expect(compare).toHaveAttribute('aria-selected', 'true');
    expect(compare).toHaveAttribute('tabindex', '0');
    expect(chat).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Compare' })).toHaveAttribute('id', compare.getAttribute('aria-controls'));
    expect(screen.getByRole('button', { name: 'Run comparison' }).disabled).toBe(false);
    expect(screen.getByText('Runs against 1 model')).toBeTruthy();
    expect(modelsToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the picker and names the next step when no model is available to select', async () => {
    getLocalLlmStatus.mockResolvedValue({ backend: 'ollama', ollama: { models: [] }, lmstudio: { models: [] } });

    renderPlayground();

    // Nothing is selectable, so the prerequisite is disclosed rather than
    // collapsed away, and the run action names why it is unavailable.
    await waitFor(() => expect(modelsToggle()).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText('No installed local models found.')).toBeTruthy();
    expect(modelsPanelCollapsed()).toBe(false);
    expect(screen.getByText(/No local models installed/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'install one' })).toHaveAttribute('href', '/models/llms');
    expect(screen.getByRole('button', { name: 'Run chat' }).disabled).toBe(true);
  });
});

describe('LocalLlmPlayground', () => {
  it('shows model size, memory requirements, and use-case tags in the selector', async () => {
    renderPlayground();

    expect(screen.getByRole('tab', { name: 'Playground' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    expect(getLocalLlmCatalog).toHaveBeenCalledWith('ollama');
    // Catalog details land one await after the status that names the model.
    expect(await screen.findByText('104B · 59 GB · ~71 GB RAM')).toBeTruthy();
    expect(screen.getByText('Tool use')).toBeTruthy();
    expect(screen.getByText('Multilingual')).toBeTruthy();
  });

  it('flags a resident model with VRAM size + eviction countdown, reconciling a case/tag-mismatched id', async () => {
    getLoadedLlmModels.mockResolvedValue({
      ollama: [
        // /api/ps reports a differently-cased id than the installed row
        // (COMMAND-R-PLUS vs command-r-plus); normalizeCatalogId must reconcile
        // them, or the badge never matches. Also carries VRAM + a future
        // eviction time so the "frees in" countdown branch runs.
        {
          id: 'COMMAND-R-PLUS:104B',
          name: 'COMMAND-R-PLUS:104B',
          size: 59 * 1024 ** 3,
          sizeVram: 60 * 1024 ** 3,
          expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        },
      ],
    });

    renderPlayground();

    // The badge reports residency AND the model's VRAM footprint (60 GB), the
    // countdown renders ("frees in 1h"), and the header chip counts it.
    await waitFor(() => expect(screen.getByText(/In memory · 60 GB/)).toBeTruthy());
    expect(screen.getByText(/frees in 1h/)).toBeTruthy();
    expect(screen.getByText(/1 in memory/)).toBeTruthy();
  });

  it('marks the model row "Processing" (not "In memory") while a chat run is in flight', async () => {
    // No model is resident (default mock), but the in-flight run drives the
    // selected model — the row should show the run-derived "Processing" badge,
    // not residency. Hold the run open so the badge stays mounted while asserting.
    let releaseRun;
    const runGate = new Promise((resolve) => { releaseRun = resolve; });
    streamLocalLlmTest.mockImplementation(async () => {
      await runGate;
      return { backend: 'ollama', modelId: 'command-r-plus:104b', text: 'ok', runId: 'r1', timings: {} };
    });

    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Run chat'));

    await waitFor(() => expect(screen.getByText('Processing')).toBeTruthy());
    expect(screen.queryByText(/In memory/)).toBeNull();

    // Releasing the run resolves the stream promise, which settles the result
    // state — flush it inside act() so that update is wrapped.
    await act(async () => { releaseRun(); });
  });

  it('renders a live "Thinking" block for streamed reasoning, separate from the answer', async () => {
    // Drive reasoning tokens then a content token through the streaming callback,
    // mirroring a reasoning model (deepseek-r1, qwq) that emits its chain-of-thought
    // first. The reasoning must render in its own block; the answer text stays clean.
    // Hold the run open (gate) so the live streaming panel stays mounted while we
    // assert — once the promise resolves, the panel is replaced by the result.
    let releaseRun;
    const runGate = new Promise((resolve) => { releaseRun = resolve; });
    streamLocalLlmTest.mockImplementation(async (_payload, { onToken }) => {
      onToken('reasoning step one ', 'reasoning');
      onToken('reasoning step two', 'reasoning');
      onToken('Final answer.', 'content');
      await runGate;
      return { backend: 'ollama', modelId: 'command-r-plus:104b', text: 'Final answer.', runId: 'run-x', timings: {} };
    });

    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Run chat'));

    // The reasoning block label and its streamed text appear (flushed on the 80ms timer).
    await waitFor(() => expect(screen.getByText('Thinking')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/reasoning step one reasoning step two/)).toBeTruthy());
    // The streaming answer renders the content channel only — reasoning isn't mixed in.
    await waitFor(() => expect(screen.getByText('Final answer.')).toBeTruthy());

    // Releasing the run resolves the stream promise, which settles the result
    // state — flush it inside act() so that update is wrapped.
    await act(async () => { releaseRun(); });
  });
});


it('reconciles loaded models on events, reconnect and tab show without polling', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    const view = renderPlayground();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getLoadedLlmModels).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getLoadedLlmModels).toHaveBeenCalledTimes(1);
    getLoadedLlmModels.mockResolvedValue({ ollama: [{ id: 'command-r-plus:104b' }] });
    await act(async () => { socketEvent('loaded-models:changed'); });
    expect(screen.getByText(/1 in memory/)).toBeInTheDocument();
    getLoadedLlmModels.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => { socketEvent('connect'); });
    expect(screen.getByText(/Memory status unavailable/)).toBeInTheDocument();
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.queryByText(/Memory status unavailable/)).not.toBeInTheDocument();
    expect(getLoadedLlmModels).toHaveBeenCalledTimes(4);
    view.unmount();
    expect(socket.emit).toHaveBeenCalledWith('loaded-models:unsubscribe');
  } finally {
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

describe('LocalLlmPlayground endpoint runtimes', () => {
  const runtimes = [
    { id: 'llama', label: 'llama.cpp', models: [{ id: 'dflash' }], offline: false, error: null },
    { id: 'mtplx', label: 'MTPLX', models: [{ id: 'mlx-community/qwen' }], offline: false, error: null },
    { id: 'splash', label: 'Splash', models: [], offline: true, error: 'not reachable at http://127.0.0.1:1/v1 (refused)' },
  ];

  it('groups a running runtime under its response label, sends its backend id and links stopped runtimes to the Runtimes page', async () => {
    getLocalRuntimeModels.mockResolvedValue({ runtimes });
    streamLocalLlmTest.mockResolvedValue({ backend: 'llama', modelId: 'dflash', text: 'hi', timings: {} });
    renderPlayground();

    expect((await screen.findAllByText('dflash')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('llama.cpp').length).toBeGreaterThan(0);
    const offline = screen.getByTestId('local-llm-offline-runtimes');
    expect(offline.textContent).toContain('Splash');
    expect(offline.textContent).toContain('not running');
    expect(offline.querySelector('a')).toHaveAttribute('href', '/models/llms-runtimes');

    // Select dflash, deselect the URL-selected Ollama model, and run a chat.
    fireEvent.click(screen.getAllByText('dflash')[0]);
    fireEvent.click(screen.getAllByText('command-r-plus:104b')[0]);
    fireEvent.click(screen.getByText('Run chat'));
    await waitFor(() => expect(streamLocalLlmTest).toHaveBeenCalled());
    expect(streamLocalLlmTest.mock.calls[0][0]).toMatchObject({ backend: 'llama', modelId: 'dflash' });
  });

  it('keeps a ?targets= runtime target through the stale-selection prune and compares it', async () => {
    getLocalRuntimeModels.mockResolvedValue({ runtimes });
    const targets = encodeURIComponent(JSON.stringify([{ backend: 'mtplx', modelId: 'mlx-community/qwen' }]));
    compareLocalLlmModels.mockResolvedValue({ mode: 'round-robin', prompt: 'p', results: [] });
    renderPlayground(`/local-llm/playground?mode=compare&targets=${targets}`);

    await screen.findAllByText('mlx-community/qwen');
    fireEvent.click(screen.getByText('Run comparison'));
    await waitFor(() => expect(compareLocalLlmModels).toHaveBeenCalled());
    expect(compareLocalLlmModels.mock.calls[0][0].targets).toEqual([{ backend: 'mtplx', modelId: 'mlx-community/qwen' }]);
  });

  it('names a listing error and an empty catalog instead of calling every runtime stopped', async () => {
    getLocalRuntimeModels.mockResolvedValue({ runtimes: [
      { id: 'vllm', label: 'vLLM', models: [], offline: true, error: 'HTTP 401 from the model listing' },
      { id: 'sglang', label: 'SGLang', models: [], offline: false, error: null },
    ] });
    renderPlayground();
    const panel = await screen.findByTestId('local-llm-offline-runtimes');
    expect(panel.textContent).toContain('(HTTP 401 from the model listing)');
    expect(panel.textContent).toContain('SGLang');
    expect(panel.textContent).toContain('serves no models');
  });

  it('keeps a runtime target selected when the runtime listing request fails', async () => {
    getLocalRuntimeModels.mockRejectedValue(new Error('boom'));
    const targets = encodeURIComponent(JSON.stringify([{ backend: 'llama', modelId: 'dflash' }]));
    streamLocalLlmTest.mockResolvedValue({ backend: 'llama', modelId: 'dflash', text: 'x', timings: {} });
    renderPlayground(`/local-llm/playground?targets=${targets}`);
    await screen.findByText(/could not be listed: boom/);
    fireEvent.click(screen.getByText('Run chat'));
    await waitFor(() => expect(streamLocalLlmTest).toHaveBeenCalled());
    expect(streamLocalLlmTest.mock.calls[0][0]).toMatchObject({ backend: 'llama', modelId: 'dflash' });
  });

  it('keeps a selected runtime target whose own listing errored', async () => {
    getLocalRuntimeModels.mockResolvedValue({ runtimes: [
      { id: 'vllm', label: 'vLLM', models: [], offline: true, error: 'HTTP 401 from the model listing' },
      { id: 'llama', label: 'llama.cpp', models: [{ id: 'dflash' }], offline: false, error: null },
    ] });
    streamLocalLlmTest.mockResolvedValue({ backend: 'vllm', modelId: 'm', text: 'x', timings: {} });
    const targets = encodeURIComponent(JSON.stringify([{ backend: 'vllm', modelId: 'm' }]));
    renderPlayground(`/local-llm/playground?targets=${targets}`);
    await screen.findByTestId('local-llm-offline-runtimes');
    fireEvent.click(screen.getByText('Run chat'));
    await waitFor(() => expect(streamLocalLlmTest).toHaveBeenCalled());
    expect(streamLocalLlmTest.mock.calls[0][0]).toMatchObject({ backend: 'vllm', modelId: 'm' });
  });

  it('lets the user remove a retained unavailable target and run a listed model instead', async () => {
    getLocalRuntimeModels.mockResolvedValue({ runtimes: [
      { id: 'vllm', label: 'vLLM', models: [], offline: true, error: 'HTTP 401 from the model listing' },
      { id: 'llama', label: 'llama.cpp', models: [{ id: 'dflash' }], offline: false, error: null },
    ] });
    streamLocalLlmTest.mockResolvedValue({ backend: 'llama', modelId: 'dflash', text: 'x', timings: {} });
    const targets = encodeURIComponent(JSON.stringify([{ backend: 'vllm', modelId: 'm' }]));
    renderPlayground(`/local-llm/playground?targets=${targets}`);
    const row = await screen.findByTestId('local-llm-unavailable-selected');
    fireEvent.click(screen.getAllByText('dflash')[0]);
    fireEvent.click(row.querySelector('button'));
    fireEvent.click(screen.getByText('Run chat'));
    await waitFor(() => expect(streamLocalLlmTest).toHaveBeenCalled());
    expect(streamLocalLlmTest.mock.calls[0][0]).toMatchObject({ backend: 'llama', modelId: 'dflash' });
  });

  it('renders Ollama models while the runtime listing is still pending', async () => {
    getLocalRuntimeModels.mockReturnValue(new Promise(() => {}));
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));
  });

  it('renders runtime models and names the error when the managed status request fails', async () => {
    getLocalLlmStatus.mockRejectedValue(new Error('status down'));
    getLocalRuntimeModels.mockResolvedValue({ runtimes });
    renderPlayground();
    expect((await screen.findAllByText('dflash')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Ollama and LM Studio could not be listed: status down/)).toBeTruthy();
  });

  it('still lists Ollama models when the runtime listing fails', async () => {
    getLocalRuntimeModels.mockRejectedValue(new Error('boom'));
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('local-llm-offline-runtimes')).toBeNull();
    expect(screen.getByText(/could not be listed: boom/)).toBeTruthy();
  });
});
