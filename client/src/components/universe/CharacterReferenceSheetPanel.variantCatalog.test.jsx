/**
 * The variant catalog is cached for the page session, but a failed read must
 * not be: one transient failure would otherwise pin every later panel to the
 * standard-only fallback until reload.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CharacterReferenceSheetPanel from './CharacterReferenceSheetPanel';

const fetchVariants = vi.hoisted(() => vi.fn());
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../services/apiUniverseBuilder', () => ({
  fetchReferenceSheetVariants: (...args) => fetchVariants(...args),
  getCharacterReferenceSheet: async () => ({ filename: null, pendingJobId: null }),
  renderCharacterReferenceSheet: vi.fn(),
  previewCharacterReferenceSheet: async () => ({ preview: { sentPrompt: '', referenceImages: [] } }),
  deleteCharacterReferenceSheet: vi.fn(),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'idle', progress: 0 }) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../MediaImage', () => ({ default: (props) => <img src={props.src} alt={props.alt} /> }));

const entry = { id: 'c-1', name: 'Example Character' };

describe('reference-sheet variant catalog', () => {
  it('retries the catalog on the next mount after a failed read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchVariants
      .mockRejectedValueOnce(new Error('catalog down'))
      .mockResolvedValueOnce({ variants: [
        { id: 'standard', label: 'Reference sheet' },
        { id: 'expressions', label: 'Expression sheet' },
      ] });

    const first = render(<CharacterReferenceSheetPanel universeId="u-1" entry={entry} />);
    expect(await screen.findByText('Reference sheet')).toBeInTheDocument();
    expect(screen.queryByText('Expression sheet')).not.toBeInTheDocument();
    first.unmount();

    render(<CharacterReferenceSheetPanel universeId="u-1" entry={entry} />);
    expect(await screen.findByText('Expression sheet')).toBeInTheDocument();
  });
});
