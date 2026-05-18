import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// CanonCard subscribes to live job progress via the socket-backed hook; the
// chip-label code path doesn't touch it, but the hook would otherwise wire
// up listeners during render. Stub it to a neutral resting state.
vi.mock('../../hooks/useMediaJobProgress', () => ({
  __esModule: true,
  default: () => ({ status: 'unknown', filename: null, error: null }),
}));

// MediaJobThumb is rendered only when `inFlightJobId` is truthy — none of
// these tests exercise that, so a stub keeps the test runtime self-contained.
vi.mock('./MediaJobThumb', () => ({
  __esModule: true,
  default: () => null,
}));

import CanonCard from './CanonCard';

const kind = {
  key: 'characters',
  label: 'Characters',
  descFor: (e) => e.description || '',
};

const baseEntry = {
  id: 'ent-1',
  name: 'Lyra',
  description: 'Cartographer-spy.',
};

const render_ = (props) => render(
  <CanonCard
    kind={kind}
    entry={baseEntry}
    onRender={() => {}}
    {...props}
  />
);

describe('CanonCard — "from series" provenance chip', () => {
  it('omits the chip entirely when sourceSeriesId is absent', () => {
    render_();
    expect(screen.queryByText(/^from /)).not.toBeInTheDocument();
    expect(screen.queryByText('from series')).not.toBeInTheDocument();
  });

  it('falls back to generic "from series" label + id tooltip when seriesNameMap is missing', () => {
    render_({ entry: { ...baseEntry, sourceSeriesId: 'ser-abc' } });
    const chip = screen.getByText('from series');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'Introduced by series ser-abc');
  });

  it('renders the series name from seriesNameMap and includes id in tooltip', () => {
    render_({
      entry: { ...baseEntry, sourceSeriesId: 'ser-abc' },
      seriesNameMap: { 'ser-abc': 'Phantom Pact' },
    });
    const chip = screen.getByText('from Phantom Pact');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'Introduced by series "Phantom Pact" (ser-abc)');
  });

  it('falls back to generic label when sourceSeriesId is not present in seriesNameMap', () => {
    render_({
      entry: { ...baseEntry, sourceSeriesId: 'ser-missing' },
      seriesNameMap: { 'ser-other': 'Other Series' },
    });
    expect(screen.getByText('from series')).toBeInTheDocument();
    expect(screen.queryByText(/from ser-missing/)).not.toBeInTheDocument();
  });
});

describe('CanonCard — wardrobe pending-row promotion', () => {
  const renderEditable = (onPatchEntry) => render(
    <CanonCard
      kind={kind}
      entry={{ ...baseEntry, wardrobes: [] }}
      onRender={() => {}}
      onPatchEntry={onPatchEntry}
    />,
  );

  it('promotes a pending wardrobe row on name blur with a client-minted wd-<uuid> id', () => {
    const onPatchEntry = vi.fn();
    renderEditable(onPatchEntry);
    fireEvent.click(screen.getByText(/Outfits/));
    fireEvent.click(screen.getByText(/Add outfit/));
    const nameInput = screen.getByPlaceholderText(/Outfit name/);
    fireEvent.change(nameInput, { target: { value: 'Wedding' } });
    fireEvent.blur(nameInput);
    expect(onPatchEntry).toHaveBeenCalledTimes(1);
    const [entryId, patch] = onPatchEntry.mock.calls[0];
    expect(entryId).toBe('ent-1');
    expect(patch.wardrobes).toHaveLength(1);
    expect(patch.wardrobes[0].name).toBe('Wedding');
    // Server-shaped id minted client-side — survives promotion verbatim.
    expect(patch.wardrobes[0].id).toMatch(/^wd-/);
    expect(patch.wardrobes[0].id).not.toMatch(/^pending-/);
  });

  it('does not promote when the user only types a description (name still empty)', () => {
    const onPatchEntry = vi.fn();
    renderEditable(onPatchEntry);
    fireEvent.click(screen.getByText(/Outfits/));
    fireEvent.click(screen.getByText(/Add outfit/));
    const descInput = screen.getByPlaceholderText(/What's the character wearing/);
    fireEvent.change(descInput, { target: { value: 'Cream linen' } });
    fireEvent.blur(descInput);
    // Description-only commits stay in the local pendingNew buffer — server
    // sanitizer would drop a nameless wardrobe row, so the parent never sees it.
    expect(onPatchEntry).not.toHaveBeenCalled();
  });

  it('does not promote on whitespace-only name', () => {
    const onPatchEntry = vi.fn();
    renderEditable(onPatchEntry);
    fireEvent.click(screen.getByText(/Outfits/));
    fireEvent.click(screen.getByText(/Add outfit/));
    const nameInput = screen.getByPlaceholderText(/Outfit name/);
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.blur(nameInput);
    expect(onPatchEntry).not.toHaveBeenCalled();
  });
});
