import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const listUniverseStyles = vi.fn();
vi.mock('../../services/api', () => ({
  listUniverseStyles: (...args) => listUniverseStyles(...args),
}));

import UniverseStylePicker from './UniverseStylePicker';

const STYLES = [{
  id: 'u-1',
  name: 'Example Universe',
  influences: { embrace: ['inky linework'], avoid: ['glossy'] },
}];

describe('UniverseStylePicker', () => {
  beforeEach(() => {
    listUniverseStyles.mockReset().mockResolvedValue(STYLES);
  });

  it('loads styled universes with a silent request and pairs the label to the select', async () => {
    render(<UniverseStylePicker value="" onChange={() => {}} />);

    const select = await screen.findByLabelText('Universe style');
    const label = screen.getByText('Universe style').closest('label');
    expect(listUniverseStyles).toHaveBeenCalledWith({ silent: true });
    expect(label.getAttribute('for')).toBe(select.id);
    expect(screen.getByRole('option', { name: 'Example Universe' })).toBeInTheDocument();
  });

  it('returns the selected universe and previews both style directions', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<UniverseStylePicker value="" onChange={onChange} />);
    const select = await screen.findByLabelText('Universe style');

    fireEvent.change(select, { target: { value: 'u-1' } });
    rerender(<UniverseStylePicker value="u-1" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith(STYLES[0]);
    expect(screen.getByText('Positive: inky linework')).toBeInTheDocument();
    expect(screen.getByText('Negative: glossy')).toBeInTheDocument();
  });

  it('renders nothing when no universe has style tokens', async () => {
    listUniverseStyles.mockResolvedValue([]);
    render(<UniverseStylePicker value="" onChange={() => {}} />);
    await waitFor(() => expect(listUniverseStyles).toHaveBeenCalled());
    expect(screen.queryByLabelText('Universe style')).not.toBeInTheDocument();
  });
});
