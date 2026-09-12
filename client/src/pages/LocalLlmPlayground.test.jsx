import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getLocalLlmCatalog: vi.fn(),
  getLoadedLlmModels: vi.fn(),
  streamLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import LocalLlmPlayground from './LocalLlmPlayground';
import { getLoadedLlmModels, getLocalLlmCatalog, getLocalLlmStatus, streamLocalLlmTest } from '../services/api';

const renderPlayground = () => render(
  <MemoryRouter initialEntries={['/local-llm/playground?backend=ollama&model=command-r-plus%3A104b']}>
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
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(advancedToggle().textContent).toContain('round robin');
    fireEvent.click(advancedToggle());
    expect(screen.getByLabelText('Temperature').value).toBe('0.9');
    expect(screen.getByLabelText('System prompt').value).toBe('be terse');
    expect(screen.getByLabelText('Execution')).toBeTruthy();
  });

  it('exposes the compare count and Run comparison without opening the inventory', async () => {
    renderPlayground();
    await waitFor(() => expect(screen.getAllByText('command-r-plus:104b').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));

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
    expect(screen.getByText('104B · 59 GB · ~71 GB RAM')).toBeTruthy();
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
