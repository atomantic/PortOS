import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeckRenderControls from './DeckRenderControls';

// The LLM pin fetches provider state; this suite is about the render-options
// panel, the batch actions, and the notes that explain them.
vi.mock('./DeckLlmPinPicker', () => ({ default: () => <div /> }));
// The pin row probes the local catalog + the install's model pin itself, so the
// deck page threads neither through.
vi.mock('../../services/api', () => ({
  listImageModels: vi.fn().mockResolvedValue([
    { id: 'flux2-klein-9b', name: 'FLUX.2 Klein 9B' },
    { id: 'qwen-image', name: 'Qwen-Image' },
  ]),
  getSettings: vi.fn().mockResolvedValue({ imageGen: { local: { modelId: 'flux2-klein-9b' } } }),
}));
// The install modal opens its own SSE stream; this suite is about whether the
// render bar surfaces the runtime verdict and its fix, not about installing.
vi.mock('../imageGen/Flux2InstallModal', () => ({ default: () => null }));

const deck = {
  id: 'd1', kind: 'playing', imageMode: 'local', imageModelId: null, promptLlm: null,
  cardSize: { width: 1096, height: 1536 },
};
const completion = (over) => ({ total: 79, prompted: 0, rendered: 0, inFlight: 0, failed: 0, percent: 0, ...over });
// The page resolves the render target once (`useDeckRenderTarget`) and hands
// the same object to the bar and the grid, so the bar takes it as a prop.
const ready = { readiness: 'ready', modelId: 'flux2-klein-9b', model: 'FLUX.2 Klein 9B', runtimeLabel: 'Shared torch runtime', reason: null, remedy: null };
const renderTarget = (runtime = ready, over = {}) => ({
  backends: [{ id: 'local', label: 'Local' }],
  size: deck.cardSize,
  summary: 'Local · flux2-klein-9b · 1096×1536',
  localRuntime: { runtime, loading: false, refresh: vi.fn() },
  blocked: runtime?.readiness === 'unavailable',
  ...over,
});

// Async so the mount's own settings fetch settles here rather than surfacing as
// an act() warning in whichever case happens to run first.
const renderControls = async (over = {}) => {
  const props = {
    deck,
    completion: completion(),
    renderTarget: renderTarget(),
    onPatch: vi.fn(),
    onGeneratePrompts: vi.fn(),
    onRenderMissing: vi.fn(),
    onRenderAll: vi.fn(),
    ...over,
  };
  const utils = render(<DeckRenderControls {...props} />);
  await act(async () => {});
  return { ...props, ...utils };
};

const btn = (name) => screen.getByRole('button', { name });
// The pin row mounts with the section, so its catalog probe settles here.
const openOptions = async () => {
  await userEvent.click(btn(/Render options/));
  await act(async () => {});
};

describe('DeckRenderControls render options', () => {
  it('summarises the resolved backend, model and card size without a click', async () => {
    await renderControls();
    expect(btn(/Render options/)).toHaveTextContent('Local · flux2-klein-9b · 1096×1536');
  });

  it('offers this install\'s local model catalog, with the install pin as the blank option', async () => {
    const { onPatch } = await renderControls();
    await openOptions();
    const select = screen.getByRole('combobox', { name: 'Image backend model' });
    expect(screen.getByRole('option', { name: 'Default (FLUX.2 Klein 9B)' })).toBeInTheDocument();

    await userEvent.selectOptions(select, 'qwen-image');
    expect(onPatch).toHaveBeenCalledWith({ imageMode: 'local', imageModelId: 'qwen-image' });
  });

  it('persists a card size on blur, clamped to the sizes the server accepts', async () => {
    const { onPatch } = await renderControls();
    await openOptions();
    const width = screen.getByRole('spinbutton', { name: 'Card width' });
    await userEvent.clear(width);
    await userEvent.type(width, '99999');
    await userEvent.tab();
    expect(onPatch).toHaveBeenCalledWith({ cardSize: { width: 4096, height: 1536 } });
  });

  it('resets to the deck kind\'s own trim, and says which that is', async () => {
    const smaller = { ...deck, cardSize: { width: 512, height: 512 } };
    const { onPatch } = await renderControls({ deck: smaller, renderTarget: renderTarget(ready, { size: smaller.cardSize }) });
    await openOptions();
    await userEvent.click(btn(/Reset to 1096×1536/));
    expect(onPatch).toHaveBeenCalledWith({ cardSize: { width: 1096, height: 1536 } });
  });

  it('disables the reset once the deck is already at its kind default', async () => {
    await renderControls();
    await openOptions();
    expect(btn(/Reset to 1096×1536/)).toBeDisabled();
  });
});

describe('DeckRenderControls', () => {
  it('says in the page why generating prompts is unavailable on a fully prompted deck', async () => {
    await renderControls({ completion: completion({ prompted: 79, inFlight: 1 }) });
    expect(btn(/^Generate prompts$/)).toBeDisabled();
    // The reason is rendered text, not a title — a disabled button has no
    // hover on touch and no focus anywhere.
    expect(screen.getByText('All 79 cards have a prompt — rewrite to replace them.')).toBeInTheDocument();
    expect(btn(/^Rewrite all \(79\)$/)).toBeEnabled();
    // ...and it is programmatically tied to the button, not merely nearby.
    const note = screen.getByText('All 79 cards have a prompt — rewrite to replace them.');
    expect(btn(/^Generate prompts$/)).toHaveAttribute('aria-describedby', note.id);
  });

  it('says why rendering is unavailable before any prompt exists', async () => {
    await renderControls();
    expect(btn(/^Render missing \(79\)$/)).toBeDisabled();
    expect(btn(/^Render all$/)).toBeDisabled();
    expect(screen.getByText('A card renders from its prompt. Write prompts first.')).toBeInTheDocument();
    expect(screen.getByText('79 of 79 cards still need a prompt.')).toBeInTheDocument();
  });

  it('counts in-flight cards out of the render-missing total and names them', async () => {
    await renderControls({ completion: completion({ prompted: 79, rendered: 0, inFlight: 1 }) });
    expect(btn(/^Render missing \(78\)$/)).toBeEnabled();
    expect(screen.getByText('78 prompted cards not rendered yet · 1 card rendering now.')).toBeInTheDocument();
  });

  it('moves the accent button from step 1 to step 2 as the deck becomes fully prompted', async () => {
    const { unmount } = await renderControls({ completion: completion({ prompted: 10 }) });
    expect(btn(/^Generate prompts \(69\)$/).className).toContain('bg-port-accent');
    expect(btn(/^Render missing \(79\)$/).className).not.toContain('bg-port-accent');
    unmount();

    await renderControls({ completion: completion({ prompted: 79 }) });
    expect(btn(/^Generate prompts$/).className).not.toContain('bg-port-accent');
    expect(btn(/^Render missing \(79\)$/).className).toContain('bg-port-accent');
  });
});

// A deck renders on the same local runtime the Image Gen page and Settings
// report. Before the shared verdict reached here, a deck whose runtime was
// broken offered "Render all" as though it would work, and the cards came back
// as unexplained "Failed" badges.
describe('DeckRenderControls local runtime', () => {
  const broken = {
    readiness: 'unavailable', modelId: 'flux2-klein-9b', model: 'FLUX.2 Klein 9B',
    runtimeLabel: 'Shared torch runtime',
    reason: 'The shared torch image runtime is not installed or healthy (expected at /home/u/.portos/venv-flux2/bin/python3)',
    remedy: { kind: 'install-torch-venv', label: 'Install runtime', venvPath: '/home/u/.portos/venv-flux2/bin/python3' },
  };

  it('stays silent about a healthy runtime, and leaves the render buttons alone', async () => {
    await renderControls({ completion: completion({ prompted: 79 }) });
    expect(screen.queryByRole('button', { name: /install runtime/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Render all/ })).toBeEnabled();
  });

  it('names the broken runtime and offers its one-button fix before any render is queued', async () => {
    await renderControls({ renderTarget: renderTarget(broken) });
    expect(screen.getByText(/not installed or healthy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /install runtime/i })).toBeInTheDocument();
  });

  // The reported complaint one step earlier than the error message: queueing a
  // whole deck against a runtime the server is going to refuse.
  it('stands the render buttons down while the runtime is unavailable, and says why', async () => {
    await renderControls({ completion: completion({ prompted: 79 }), renderTarget: renderTarget(broken) });
    expect(screen.getByRole('button', { name: /^Render all/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Render missing/ })).toBeDisabled();
    expect(screen.getByText(/local image runtime is unavailable/i)).toBeInTheDocument();
  });

  // An unanswerable probe must not be able to lock a working deck out.
  it('does not block rendering on an unknown verdict', async () => {
    const unknown = { readiness: 'unknown', modelId: 'flux2-klein-9b', model: 'FLUX.2 Klein 9B', reason: 'Could not verify', remedy: null };
    await renderControls({ completion: completion({ prompted: 79 }), renderTarget: renderTarget(unknown) });
    expect(screen.getByRole('button', { name: /^Render all/ })).toBeEnabled();
  });
});

// A prompt run over a 79-card tarot deck takes minutes across several LLM
// calls. The step-1 note is the live progress line while it runs — phase,
// written/requested, and which batch just landed — instead of a bare spinner.
describe('DeckRenderControls prompt progress', () => {
  it('shows the live written/requested counts and batch while a run is in flight', async () => {
    await renderControls({
      generating: true,
      generatingStatus: 'Writing prompts… 24 of 79 · batch 2 of 7',
    });
    expect(screen.getByText('Writing prompts… 24 of 79 · batch 2 of 7')).toBeInTheDocument();
  });

  it('names the casting phase before the first prompt chunk lands', async () => {
    await renderControls({ generating: true, generatingStatus: 'Casting the universe onto the cards…' });
    expect(screen.getByText('Casting the universe onto the cards…')).toBeInTheDocument();
  });

  it('falls back to the spinner copy with no status line', async () => {
    await renderControls({ generating: true, generatingStatus: null });
    // The button carries the same copy — pin the step note paragraph.
    expect(screen.getByText('Writing prompts…', { selector: 'p' })).toBeInTheDocument();
  });
});
