import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MoodBoardStyleSynthesis from './MoodBoardStyleSynthesis';

const apiMocks = vi.hoisted(() => ({
  synthesizeMoodBoardStyle: vi.fn(),
}));
vi.mock('../../services/api', () => ({ ...apiMocks }));
vi.mock('../../hooks/useProviderModels', () => ({
  default: vi.fn(() => ({
    providers: [{ id: 'ollama', name: 'Ollama', type: 'api', enabled: true }],
    selectedProviderId: 'ollama',
    selectedModel: 'qwen',
    availableModels: ['qwen'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  })),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const synthesis = {
  proposed: {
    styleNotes: 'Tactile ink-wash science fiction.',
    influences: { embrace: ['ink wash'], avoid: ['gloss'] },
  },
  diff: {
    hasChanges: true,
    styleNotes: { before: 'Clean vector art', after: 'Tactile ink-wash science fiction.', changed: true },
    influences: {
      embrace: { changed: true, added: ['ink wash'], removed: ['clean vectors'] },
      avoid: { changed: true, added: ['gloss'], removed: ['grain'] },
    },
  },
  rationale: 'The board trades polish for tactile marks.',
  context: { items: 3, droppedItems: 0 },
  llm: { provider: 'ollama', model: 'qwen' },
};

const baseProps = {
  boardId: 'mb-1',
  universeId: 'u1',
  styleNotes: 'Clean vector art',
  influences: { embrace: ['clean vectors'], avoid: ['grain'] },
  locked: { influencesAvoid: true },
  saved: true,
};

const renderPanel = (props = {}) => render(
  <MoodBoardStyleSynthesis {...baseProps} {...props} />,
);

const runSynthesis = async () => {
  fireEvent.click(screen.getByRole('button', { name: /synthesize style/i }));
  fireEvent.click(screen.getByRole('button', { name: /^synthesize$/i }));
  await waitFor(() => expect(screen.getByText('Style guide preview')).toBeInTheDocument());
};

describe('MoodBoardStyleSynthesis (#4188 Phase 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing without a linked board and disables the trigger until saved', () => {
    const { container } = render(<MoodBoardStyleSynthesis boardId="" universeId="u1" saved />);
    expect(container.firstChild).toBeNull();

    renderPanel({ saved: false });
    expect(screen.getByRole('button', { name: /synthesize style/i })).toBeDisabled();
  });

  it('synthesizes with the draft style context, previews the diff, and adopts through the caller', async () => {
    apiMocks.synthesizeMoodBoardStyle.mockResolvedValue(synthesis);
    const onAdopt = vi.fn().mockResolvedValue(true);

    renderPanel({ onAdopt });
    await runSynthesis();

    expect(apiMocks.synthesizeMoodBoardStyle).toHaveBeenCalledWith('mb-1', {
      styleNotes: 'Clean vector art',
      influences: { embrace: ['clean vectors'], avoid: ['grain'] },
      locked: { influencesAvoid: true },
      providerId: 'ollama',
      model: 'qwen',
    }, { silent: true });
    expect(screen.getByText('+ ink wash')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /adopt style/i }));
    await waitFor(() => {
      expect(onAdopt).toHaveBeenCalledWith({
        styleNotes: 'Tactile ink-wash science fiction.',
        influences: { embrace: ['ink wash'], avoid: ['gloss'] },
      });
    });
    // A successful adopt closes the modal (force path — the parent's busy
    // gate hasn't re-rendered yet when the body requests the close).
    await waitFor(() => {
      expect(screen.queryByText('Style guide preview')).toBeNull();
    });
  });

  it('disables Adopt when the proposal matches the current guidance', async () => {
    apiMocks.synthesizeMoodBoardStyle.mockResolvedValue({
      ...synthesis,
      diff: { ...synthesis.diff, hasChanges: false },
    });
    renderPanel();
    await runSynthesis();
    expect(screen.getByRole('button', { name: /adopt style/i })).toBeDisabled();
  });

  it('discards a stale proposal when the target universe changes (remount by key)', async () => {
    apiMocks.synthesizeMoodBoardStyle.mockResolvedValue(synthesis);
    const { rerender } = renderPanel();
    await runSynthesis();
    expect(screen.getByRole('button', { name: /adopt style/i })).toBeInTheDocument();

    // Navigating to a different universe while the modal is open must wipe
    // the proposal — adopting universe A's synthesis into B would silently
    // copy one universe's style into another.
    rerender(<MoodBoardStyleSynthesis {...baseProps} universeId="u2" />);
    expect(screen.queryByRole('button', { name: /adopt style/i })).toBeNull();
    expect(screen.queryByText('Style guide preview')).toBeNull();
  });
});
