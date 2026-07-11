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

import { TimelineBlock } from './VideoTimelineEditor';

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
