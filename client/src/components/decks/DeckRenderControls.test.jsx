import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeckRenderControls from './DeckRenderControls';

// The backend row and the LLM pin both fetch provider/settings state; this
// suite is about the batch actions and the notes that explain them.
vi.mock('../../hooks/useImageRenderSettings', () => ({
  default: () => ({ imageCfg: { mode: 'local', modelId: 'qwen-image' }, backends: [{ id: 'local', label: 'Local' }] }),
}));
vi.mock('./DeckLlmPinPicker', () => ({ default: () => <div /> }));

const deck = { id: 'd1', imageMode: null, imageModelId: null, promptLlm: null, cardSize: { width: 1024, height: 1536 } };
const completion = (over) => ({ total: 79, prompted: 0, rendered: 0, inFlight: 0, failed: 0, percent: 0, ...over });

const renderControls = (over = {}) => {
  const props = {
    deck,
    completion: completion(),
    onPatch: vi.fn(),
    onGeneratePrompts: vi.fn(),
    onRenderMissing: vi.fn(),
    onRenderAll: vi.fn(),
    ...over,
  };
  return { ...props, ...render(<DeckRenderControls {...props} />) };
};

const btn = (name) => screen.getByRole('button', { name });

describe('DeckRenderControls', () => {
  it('says in the page why generating prompts is unavailable on a fully prompted deck', () => {
    renderControls({ completion: completion({ prompted: 79, inFlight: 1 }) });
    expect(btn(/^Generate prompts$/)).toBeDisabled();
    // The reason is rendered text, not a title — a disabled button has no
    // hover on touch and no focus anywhere.
    expect(screen.getByText('All 79 cards have a prompt — rewrite to replace them.')).toBeInTheDocument();
    expect(btn(/^Rewrite all \(79\)$/)).toBeEnabled();
    // ...and it is programmatically tied to the button, not merely nearby.
    const note = screen.getByText('All 79 cards have a prompt — rewrite to replace them.');
    expect(btn(/^Generate prompts$/)).toHaveAttribute('aria-describedby', note.id);
  });

  it('says why rendering is unavailable before any prompt exists', () => {
    renderControls();
    expect(btn(/^Render missing \(79\)$/)).toBeDisabled();
    expect(btn(/^Render all$/)).toBeDisabled();
    expect(screen.getByText('A card renders from its prompt. Write prompts first.')).toBeInTheDocument();
    expect(screen.getByText('79 of 79 cards still need a prompt.')).toBeInTheDocument();
  });

  it('counts in-flight cards out of the render-missing total and names them', () => {
    renderControls({ completion: completion({ prompted: 79, rendered: 0, inFlight: 1 }) });
    expect(btn(/^Render missing \(78\)$/)).toBeEnabled();
    expect(screen.getByText('78 prompted cards not rendered yet · 1 card rendering now.')).toBeInTheDocument();
  });

  it('moves the accent button from step 1 to step 2 as the deck becomes fully prompted', () => {
    const { unmount } = renderControls({ completion: completion({ prompted: 10 }) });
    expect(btn(/^Generate prompts \(69\)$/).className).toContain('bg-port-accent');
    expect(btn(/^Render missing \(79\)$/).className).not.toContain('bg-port-accent');
    unmount();

    renderControls({ completion: completion({ prompted: 79 }) });
    expect(btn(/^Generate prompts$/).className).not.toContain('bg-port-accent');
    expect(btn(/^Render missing \(79\)$/).className).toContain('bg-port-accent');
  });
});
