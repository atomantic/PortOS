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

import { TimelineBlock, LaneBlock, clampTrim, fitFadePatch } from './VideoTimelineEditor';

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

describe('clampTrim', () => {
  const segment = { inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0 };

  it('clamps out to the source duration', () => {
    expect(clampTrim(segment, { outSec: 99 }, 5, 24)).toMatchObject({ outSec: 5 });
  });

  it('keeps at least one frame between in and out, matching the server guard', () => {
    // 24fps → 1/24s minimum, not the old hardcoded 0.04.
    expect(clampTrim(segment, { inSec: 4 }, 4, 24).outSec - clampTrim(segment, { inSec: 4 }, 4, 24).inSec)
      .toBeCloseTo(1 / 24);
  });

  it('shrinks fades that no longer fit the tightened trim', () => {
    const faded = { inSec: 0, outSec: 4, fadeInSec: 1, fadeOutSec: 1 };
    const patched = clampTrim(faded, { outSec: 1 }, 4, 24);
    expect(patched.fadeInSec + patched.fadeOutSec).toBeCloseTo(1);
  });
});

describe('fitFadePatch', () => {
  it('leaves a fitting fade pair untouched', () => {
    expect(fitFadePatch({ fadeInSec: 0.5, fadeOutSec: 0.5 }, { fadeInSec: 1 }, 4)).toEqual({ fadeInSec: 1 });
  });

  it('scales an over-long pair down proportionally rather than dropping one', () => {
    const patched = fitFadePatch({ fadeInSec: 1, fadeOutSec: 3 }, { fadeInSec: 1 }, 2);
    expect(patched.fadeInSec).toBeCloseTo(0.5);
    expect(patched.fadeOutSec).toBeCloseTo(1.5);
  });

  it('zeroes both fades when the duration collapses', () => {
    const patched = fitFadePatch({ fadeInSec: 1, fadeOutSec: 1 }, { durationSec: 0 }, 0);
    expect(patched).toMatchObject({ fadeInSec: 0, fadeOutSec: 0 });
  });
});
