import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeckStylePanel from './DeckStylePanel';

vi.mock('./DeckSampleModal', () => ({ default: () => null }));
vi.mock('../universeBuilder/InfluenceChipsInput', () => ({
  default: ({ tokens = [] }) => <div>{tokens.join(', ')}</div>,
}));

const deck = {
  id: 'd1',
  kind: 'playing',
  description: '',
  styleNotes: '',
  layoutPrompt: 'Complete playing card',
  cardOrientation: 'standard',
  cardOrientationPrompt: null,
  influences: { embrace: [], avoid: [] },
  samples: [],
  universeId: null,
  cardSize: { width: 1096, height: 1536 },
};

const renderPanel = (over = {}) => {
  const props = {
    deck: { ...deck, ...over },
    universes: [],
    onPatch: vi.fn(),
    onDeckReplaced: vi.fn(),
    onRemoveSample: vi.fn(),
  };
  render(<DeckStylePanel {...props} />);
  return props;
};

describe('DeckStylePanel face orientation', () => {
  it('shows the standard two-way guard and persists a changed orientation', async () => {
    const user = userEvent.setup();
    const { onPatch } = renderPanel();

    expect(screen.getByRole('combobox', { name: 'Card face orientation' })).toHaveValue('standard');
    expect(screen.getByDisplayValue(/Standard two-way playing-card face/)).toBeInTheDocument();
    expect(screen.getByText(/bottom-right index is rotated 180°/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Card face orientation' }), 'one-way');
    expect(onPatch).toHaveBeenCalledWith({ cardOrientation: 'one-way' });
  });

  it('lets an authored orientation prompt be edited or restored to the built-in wording', async () => {
    const user = userEvent.setup();
    const { onPatch } = renderPanel({ cardOrientationPrompt: 'Use a custom diagonal index treatment' });
    const prompt = screen.getByLabelText('Face-orientation prompt (built-in, overridable)');

    expect(prompt).toHaveValue('Use a custom diagonal index treatment');
    await user.click(screen.getByRole('button', { name: 'Use built-in' }));
    expect(onPatch).toHaveBeenCalledWith({ cardOrientationPrompt: null });
  });
});
