import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const dndPointerDown = vi.hoisted(() => vi.fn());

vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual('@dnd-kit/sortable');
  return {
    ...actual,
    useSortable: () => ({
      attributes: {},
      listeners: { onPointerDown: dndPointerDown },
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

import { TimelineBlock, LaneBlock, FloatingLane, BedAudio } from './VideoTimelineLanes';

const clip = { _key: 'clip-key', clipId: 'clip-1', inSec: 0, outSec: 2 };
const clipMeta = { prompt: 'A dramatic sunrise' };

const renderBlock = (props = {}) => {
  const onSelect = vi.fn();
  const onRemove = vi.fn();
  render(
    <TimelineBlock
      clip={clip}
      clipMeta={clipMeta}
      isSelected={false}
      isMissing={false}
      pxPerSec={60}
      onSelect={onSelect}
      onRemove={onRemove}
      {...props}
    />,
  );
  return { onSelect, onRemove };
};

beforeEach(() => {
  dndPointerDown.mockClear();
});

describe('TimelineBlock — remove control', () => {
  it('provides a 44px hit target and a clip-specific accessible label', () => {
    renderBlock();

    const remove = screen.getByRole('button', { name: 'Remove A dramatic sunrise from timeline' });
    expect(remove.className).toContain('min-w-[44px]');
    expect(remove.className).toContain('min-h-[44px]');
    expect(remove.className).toContain('lg:opacity-0');
    expect(remove.className).not.toContain('sm:opacity-0');
    expect(remove).toHaveAttribute('title', 'Remove from timeline');
    expect(remove.querySelector('svg').className.baseVal).toContain('w-3 h-3');
  });

  it('removes without starting a drag or selecting the parent timeline block', () => {
    const { onSelect, onRemove } = renderBlock();
    const remove = screen.getByRole('button', { name: 'Remove A dramatic sunrise from timeline' });

    fireEvent.pointerDown(remove);
    fireEvent.click(remove);

    expect(dndPointerDown).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith('clip-key');
  });
});

describe('TimelineBlock — heterogeneous segments', () => {
  it('renders a still by its asset filename, thumbnailed from the gallery', () => {
    render(
      <TimelineBlock
        clip={{ _key: 'still-key', type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3 }}
        clipMeta={null}
        isSelected={false}
        isMissing={false}
        pxPerSec={60}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('still · 3.00s')).toBeInTheDocument();
    expect(screen.getByText('plate.png')).toBeInTheDocument();
    expect(document.querySelector('img')).toHaveAttribute('src', '/data/images/plate.png');
    expect(screen.getByRole('button', { name: 'Remove plate.png from timeline' })).toBeInTheDocument();
  });

  it('sizes a clip block from its TRIMMED length, not the source length', () => {
    render(
      <TimelineBlock
        clip={{ _key: 'k', type: 'clip', clipId: 'c', inSec: 1, outSec: 3 }}
        clipMeta={{ prompt: 'A dramatic sunrise' }}
        isSelected={false}
        isMissing={false}
        pxPerSec={50}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('2.00s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove A dramatic sunrise/ }).closest('div')).toHaveStyle({ width: '100px' });
  });

  it('draws fade ramps proportional to the segment, and none when a fade is zero', () => {
    const { unmount } = render(
      <TimelineBlock
        clip={{ _key: 'k', type: 'clip', clipId: 'c', inSec: 0, outSec: 4, fadeInSec: 1, fadeOutSec: 0 }}
        clipMeta={{ prompt: 'p' }}
        isSelected={false}
        isMissing={false}
        pxPerSec={60}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId('fade-in-ramp')).toHaveStyle({ width: '25%' });
    expect(screen.queryByTestId('fade-out-ramp')).not.toBeInTheDocument();
    unmount();

    render(
      <TimelineBlock
        clip={{ _key: 'k', type: 'clip', clipId: 'c', inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 2 }}
        clipMeta={{ prompt: 'p' }}
        isSelected={false}
        isMissing={false}
        pxPerSec={60}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fade-out-ramp')).toHaveStyle({ width: '50%' });
  });
});

describe('LaneBlock — free-floating overlay/bed placement', () => {
  const entry = { _key: 'ov-1', startSec: 2, durationSec: 3 };

  it('positions and sizes itself in project time at the current zoom', () => {
    render(
      <LaneBlock entry={entry} label="logo.png" tone="" isSelected={false} isMissing={false} pxPerSec={40} onSelect={vi.fn()} onRemove={vi.fn()} />,
    );

    const block = screen.getByText('logo.png').closest('div');
    expect(block).toHaveStyle({ left: '80px', width: '120px' });
  });

  it('flags a missing source instead of showing a label that resolves to nothing', () => {
    render(
      <LaneBlock entry={entry} label="gone.png" tone="" isSelected={false} isMissing onSelect={vi.fn()} pxPerSec={40} onRemove={vi.fn()} />,
    );
    expect(screen.getByText('(missing)')).toBeInTheDocument();
    expect(screen.queryByText('gone.png')).not.toBeInTheDocument();
  });

  it('removes without also selecting the block', () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <LaneBlock entry={entry} label="logo.png" tone="" isSelected={false} isMissing={false} pxPerSec={40} onSelect={onSelect} onRemove={onRemove} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove logo.png from timeline' }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith('ov-1');
  });
});

describe('FloatingLane', () => {
  const overlay = (over = {}) => ({ _key: 'ov-1', assetFile: 'logo.png', startSec: 1, durationSec: 2, ...over });

  const renderLane = (props = {}) => render(
    <FloatingLane
      title="Overlays"
      entries={[overlay()]}
      emptyHint="Add an overlay from the Stills tab"
      tone=""
      labelOf={(e) => e.assetFile}
      isMissing={() => false}
      selectedKey={null}
      pxPerSec={40}
      width={400}
      playheadSec={2.5}
      onSelect={vi.fn()}
      onRemove={vi.fn()}
      {...props}
    />,
  );

  it('places its own playhead in project-time coordinates', () => {
    renderLane();
    expect(screen.getByTestId('overlays-playhead')).toHaveStyle({ left: '100px' });
  });

  it('gives each lane a distinct playhead testid so neither query is ambiguous', () => {
    renderLane();
    renderLane({ title: 'Audio' });
    expect(screen.getByTestId('overlays-playhead')).toBeInTheDocument();
    expect(screen.getByTestId('audio-playhead')).toBeInTheDocument();
  });

  it('shows the empty hint instead of a bare lane', () => {
    renderLane({ entries: [] });
    expect(screen.getByText('Add an overlay from the Stills tab')).toBeInTheDocument();
  });

  it('marks only the selected block', () => {
    renderLane({ entries: [overlay(), overlay({ _key: 'ov-2', assetFile: 'badge.png' })], selectedKey: 'ov-2' });
    // Match the selected-only fill, not `border-port-accent` — every block
    // carries that as a `hover:` variant.
    expect(screen.getByText('badge.png').closest('div').className).toContain('bg-port-accent/20');
    expect(screen.getByText('logo.png').closest('div').className).not.toContain('bg-port-accent/20');
  });
});

describe('BedAudio — registration is tied to the element lifetime', () => {
  it('registers on mount and pauses + deregisters on unmount', () => {
    const registry = new Map();
    const { unmount, rerender } = render(<BedAudio trackKey="bed-1" src="/data/music/bed.mp3" registry={registry} />);

    const el = registry.get('bed-1');
    expect(el).toBeInstanceOf(HTMLAudioElement);
    const pause = vi.spyOn(el, 'pause');

    // A re-render (which happens every animation frame during playback) must
    // NOT be mistaken for a removal.
    rerender(<BedAudio trackKey="bed-1" src="/data/music/bed.mp3" registry={registry} />);
    expect(registry.get('bed-1')).toBe(el);
    expect(pause).not.toHaveBeenCalled();

    // Removing the bed is what stops it — a detached but still-playing
    // <audio> keeps producing sound in some browsers.
    unmount();
    expect(pause).toHaveBeenCalled();
    expect(registry.has('bed-1')).toBe(false);
  });

  it('renders nothing for an unresolvable asset', () => {
    const registry = new Map();
    const { container } = render(<BedAudio trackKey="bed-1" src={null} registry={registry} />);
    expect(container.querySelector('audio')).toBeNull();
    expect(registry.size).toBe(0);
  });
});
