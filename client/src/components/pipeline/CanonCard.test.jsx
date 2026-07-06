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

describe('CanonCard — inline description editor', () => {
  const editableKind = {
    key: 'characters',
    label: 'Characters',
    descFor: (e) => e.physicalDescription || e.description || '',
    descField: 'physicalDescription',
    descFieldFallback: 'description',
    descFieldMax: 2000,
  };

  it('stays read-only when locked even with onPatchEntry wired', () => {
    const onPatchEntry = vi.fn();
    render(
      <CanonCard
        kind={editableKind}
        entry={{ ...baseEntry, physicalDescription: 'Tall.', locked: true }}
        onRender={() => {}}
        onPatchEntry={onPatchEntry}
      />,
    );
    expect(screen.getByText('Tall.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Describe Lyra/)).not.toBeInTheDocument();
  });

  it('renders a buffered textarea when unlocked + onPatchEntry + kind.descField is wired', () => {
    const onPatchEntry = vi.fn();
    render(
      <CanonCard
        kind={editableKind}
        entry={{ ...baseEntry, physicalDescription: 'Tall.' }}
        onRender={() => {}}
        onPatchEntry={onPatchEntry}
      />,
    );
    const textarea = screen.getByPlaceholderText(/Describe Lyra/);
    expect(textarea).toHaveValue('Tall.');
    fireEvent.change(textarea, { target: { value: 'Tall, sharp-eyed cartographer.' } });
    // Buffered — no PATCH until blur.
    expect(onPatchEntry).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    expect(onPatchEntry).toHaveBeenCalledWith('ent-1', { physicalDescription: 'Tall, sharp-eyed cartographer.' });
  });

  it('pre-fills from the legacy fallback field and migrates to the canonical field on save', () => {
    const onPatchEntry = vi.fn();
    render(
      <CanonCard
        kind={editableKind}
        // Legacy entry: only `description` (the fallback), no `physicalDescription`.
        entry={{ ...baseEntry, description: 'Cartographer-spy.' }}
        onRender={() => {}}
        onPatchEntry={onPatchEntry}
      />,
    );
    const textarea = screen.getByPlaceholderText(/Describe Lyra/);
    expect(textarea).toHaveValue('Cartographer-spy.');
    fireEvent.change(textarea, { target: { value: 'Cartographer-spy with a forged passport.' } });
    fireEvent.blur(textarea);
    // Migrates onto the canonical field — descFor will now prefer it.
    expect(onPatchEntry).toHaveBeenCalledWith('ent-1', { physicalDescription: 'Cartographer-spy with a forged passport.' });
  });

  it('falls back to read-only when kind.descField is absent (NounsStage / series view)', () => {
    const seriesKind = {
      key: 'characters', label: 'Characters',
      descFor: (e) => e.description || '',
      // No descField — series view stays read-only on canon descriptions.
    };
    render(
      <CanonCard
        kind={seriesKind}
        entry={baseEntry}
        onRender={() => {}}
        onPatchEntry={vi.fn()}
      />,
    );
    expect(screen.getByText('Cartographer-spy.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Describe Lyra/)).not.toBeInTheDocument();
  });
});

describe('CanonCard — reveal timing / spoiler scoping (#2178)', () => {
  const editableKind = {
    key: 'characters', label: 'Characters',
    descFor: (e) => e.physicalDescription || e.description || '',
    descField: 'physicalDescription', descFieldFallback: 'description', descFieldMax: 2000,
  };

  it('shows a spoiler badge when the entry has a revealIssue', () => {
    render_({ entry: { ...baseEntry, revealIssue: 8 } });
    expect(screen.getByText('reveal #8')).toBeInTheDocument();
  });

  it('shows a hard-spoiler badge when the entry has spoiler: true', () => {
    render_({ entry: { ...baseEntry, spoiler: true } });
    expect(screen.getByText('spoiler')).toBeInTheDocument();
  });

  it('omits the badge for an ungated entry', () => {
    render_();
    expect(screen.queryByText(/^reveal #/)).not.toBeInTheDocument();
    expect(screen.queryByText('spoiler')).not.toBeInTheDocument();
  });

  it('PATCHes revealIssue from the number input when editable', () => {
    const onPatchEntry = vi.fn();
    render(
      <CanonCard kind={editableKind} entry={baseEntry} onRender={() => {}} onPatchEntry={onPatchEntry} />,
    );
    fireEvent.click(screen.getByText(/Reveal timing/));
    const input = screen.getByLabelText(/Reveal in issue/);
    fireEvent.change(input, { target: { value: '8' } });
    expect(onPatchEntry).toHaveBeenCalledWith('ent-1', { revealIssue: 8 });
  });

  it('PATCHes spoiler from the checkbox and surfaceDescriptor on blur', () => {
    const onPatchEntry = vi.fn();
    render(
      <CanonCard kind={editableKind} entry={baseEntry} onRender={() => {}} onPatchEntry={onPatchEntry} />,
    );
    fireEvent.click(screen.getByText(/Reveal timing/));
    fireEvent.click(screen.getByLabelText(/Hard spoiler/));
    expect(onPatchEntry).toHaveBeenCalledWith('ent-1', { spoiler: true });

    const surface = screen.getByLabelText(/Surface descriptor/);
    fireEvent.change(surface, { target: { value: 'a quiet neighbor' } });
    fireEvent.blur(surface);
    expect(onPatchEntry).toHaveBeenCalledWith('ent-1', { surfaceDescriptor: 'a quiet neighbor' });
  });

  it('renders read-only reveal info when locked (no editor inputs)', () => {
    render(
      <CanonCard
        kind={editableKind}
        entry={{ ...baseEntry, revealIssue: 5, locked: true }}
        onRender={() => {}}
        onPatchEntry={vi.fn()}
      />,
    );
    expect(screen.getByText('Issue 5')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Reveal in issue/)).not.toBeInTheDocument();
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

  it('promotes via ride-along when description blurs first with a pending name draft', () => {
    // Sibling-draft ride-along: useRowDraft ships BOTH columns on either
    // commit, so a fast desc-blur after typing a name (without ever blurring
    // the name input) still promotes the row with name intact. Pre-useRowDraft
    // this case stayed in pendingNew because description's commit didn't see
    // the name draft.
    const onPatchEntry = vi.fn();
    renderEditable(onPatchEntry);
    fireEvent.click(screen.getByText(/Outfits/));
    fireEvent.click(screen.getByText(/Add outfit/));
    const nameInput = screen.getByPlaceholderText(/Outfit name/);
    const descInput = screen.getByPlaceholderText(/What's the character wearing/);
    fireEvent.change(nameInput, { target: { value: 'Wedding' } });
    fireEvent.change(descInput, { target: { value: 'Cream linen' } });
    fireEvent.blur(descInput);
    expect(onPatchEntry).toHaveBeenCalledTimes(1);
    const [, patch] = onPatchEntry.mock.calls[0];
    expect(patch.wardrobes).toHaveLength(1);
    expect(patch.wardrobes[0].name).toBe('Wedding');
    expect(patch.wardrobes[0].description).toBe('Cream linen');
  });
});
