import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoomCanvas from './LoomCanvas';

const episode = () => ({
  id: 'ep-1',
  startNodeId: 'n1',
  nodes: [
    {
      id: 'n1',
      title: 'The Gate',
      prose: 'You stand before it.',
      transitions: [{ id: 't1', targetNodeId: 'n2', intent: 'enter the gate' }],
    },
    {
      id: 'n2',
      title: 'Inside',
      prose: 'Torchlight.',
      isEnding: true,
      endingLabel: 'Within',
      transitions: [],
    },
  ],
});

const sceneY = (name) => {
  const transform = screen.getByLabelText(`Scene: ${name}`).getAttribute('transform');
  return Number(/translate\([^,]+, ([^)]+)\)/.exec(transform)?.[1]);
};

describe('LoomCanvas', () => {
  it('renders scene cards with start/ending markers and edge intent labels', () => {
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={() => {}} />);
    expect(screen.getByLabelText('Scene: The Gate')).toBeInTheDocument();
    expect(screen.getByLabelText('Scene: Inside')).toBeInTheDocument();
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.getByText('Decision loop')).toBeInTheDocument();
    expect(screen.getByText('Within')).toBeInTheDocument();
    expect(screen.getByText('enter the gate')).toBeInTheDocument();
  });

  it('packs an automatic cut tightly and omits its redundant connection label', () => {
    const automatic = episode();
    automatic.nodes[0].playbackMode = 'cut';
    automatic.nodes[0].transitions[0].intent = 'Continue';
    const { rerender } = render(
      <LoomCanvas
        episode={automatic}
        selectedNodeId={null}
        onSelectNode={() => {}}
        viewportWidth={390}
      />,
    );

    const cutStartY = sceneY('The Gate');
    const cutNextY = sceneY('Inside');
    expect(screen.queryByText('Continue')).not.toBeInTheDocument();

    rerender(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        viewportWidth={390}
      />,
    );
    const decisionStartY = sceneY('The Gate');
    const decisionNextY = sceneY('Inside');
    expect(cutNextY - cutStartY).toBeLessThan(decisionNextY - decisionStartY);
  });

  it('keeps media controls in each visual node and gives a finished video preview precedence', () => {
    const onGenerateImage = vi.fn();
    const onGenerateVideo = vi.fn();
    const onAutomateFalVideo = vi.fn();
    const withMedia = episode();
    withMedia.nodes[0] = {
      ...withMedia.nodes[0], image: 'scene.png', videoHistoryId: 'video-1',
    };
    render(
      <LoomCanvas
        episode={withMedia}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateImage={onGenerateImage}
        onGenerateVideo={onGenerateVideo}
        onAutomateFalVideo={onAutomateFalVideo}
      />,
    );

    expect(screen.getByLabelText('The Gate video preview')).toBeInTheDocument();
    expect(screen.queryByAltText('The Gate image preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate video' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Automate fal.ai' })[0]);
    expect(onGenerateImage).toHaveBeenCalledWith(withMedia.nodes[0]);
    expect(onGenerateVideo).toHaveBeenCalledWith(withMedia.nodes[0]);
    expect(onAutomateFalVideo).toHaveBeenCalledWith(withMedia.nodes[0]);
  });

  it('shows live image progress and retains an actionable failed indicator', () => {
    const { rerender } = render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateImage={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { image: { jobId: 'image-1', status: 'running', progress: 0.42, currentImage: 'AAAA' } } }}
      />,
    );
    expect(screen.getByAltText('The Gate image generation preview')).toBeInTheDocument();
    expect(screen.getByText('Generating image 42%')).toBeInTheDocument();

    rerender(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateImage={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { image: { jobId: 'image-1', status: 'failed', error: 'Synthetic failure' } } }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Image failed');
    expect(screen.getByRole('alert')).toHaveAttribute('title', 'Synthetic failure');
    expect(screen.getAllByRole('button', { name: 'Generate image' })[0]).toBeEnabled();
  });

  it('preserves numeric progress for local video jobs and uses fal browser stage messages', () => {
    const { rerender } = render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { video: {
          jobId: 'video-1', status: 'running', progress: 0.42, statusMsg: 'Sampling frames',
        } } }}
      />,
    );
    expect(screen.getByText('Generating video 42%')).toBeInTheDocument();
    expect(screen.queryByText('Sampling frames')).not.toBeInTheDocument();

    rerender(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { video: {
          jobId: 'fal-1', source: 'fal-browser', status: 'running', progress: 0.3,
          statusMsg: 'Generating the scene video on fal.ai…',
        } } }}
      />,
    );
    expect(screen.getByText('Generating the scene video on fal.ai…')).toBeInTheDocument();
  });

  it('uses absolute SVG coordinates for compact media so WebKit keeps it inside the card', () => {
    const { rerender } = render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateImage={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { image: { jobId: 'image-1', status: 'running', progress: 0.42, currentImage: 'AAAA' } } }}
      />,
    );

    const preview = screen.getByAltText('The Gate image generation preview').parentElement;
    const sceneCard = screen.getByLabelText('Scene: The Gate');
    const mediaSurface = document.querySelector('[data-node-media-id="n1"]');
    const mediaHost = mediaSurface.querySelector('div');
    const [, cardX, cardY] = /translate\(([^,]+), ([^)]+)\)/.exec(sceneCard.getAttribute('transform'));
    expect(sceneCard).not.toContainElement(mediaSurface);
    expect(mediaSurface).toHaveAttribute('x', String(Number(cardX) + 8));
    expect(mediaSurface).toHaveAttribute('y', String(Number(cardY) + 24));
    expect(mediaHost).toHaveClass('h-full', 'w-full', 'min-w-0', 'overflow-hidden');
    expect(preview).toHaveClass('grid');
    expect(preview).toHaveClass('min-w-0');
    expect(preview).not.toHaveClass('relative');
    expect(screen.getByAltText('The Gate image generation preview')).toHaveClass('block', 'min-w-0');
    expect(screen.getByText('Generating image 42%')).not.toHaveClass('absolute');

    rerender(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onGenerateImage={() => {}}
        onGenerateVideo={() => {}}
        mediaJobs={{ n1: { image: { jobId: 'image-1', status: 'failed', error: 'Synthetic failure' } } }}
      />,
    );
    expect(screen.getByRole('alert')).not.toHaveClass('absolute');
    expect(screen.getByRole('alert')).toHaveClass('self-end');
  });

  it('selects a node on keyboard activation', () => {
    const onSelectNode = vi.fn();
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={onSelectNode} />);
    fireEvent.keyDown(screen.getByLabelText('Scene: Inside'), { key: 'Enter' });
    expect(onSelectNode).toHaveBeenCalledWith('n2');
  });

  it('renders nothing for an empty episode', () => {
    const { container } = render(
      <LoomCanvas episode={{ id: 'ep-1', nodes: [] }} selectedNodeId={null} onSelectNode={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('selects the target scene from an edge intent label', () => {
    const onSelectNode = vi.fn();
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={onSelectNode} />);
    fireEvent.click(screen.getByLabelText('Path: enter the gate'));
    expect(onSelectNode).toHaveBeenCalledWith('n2');
  });

  it('keeps left-to-right flow when the page pins orientation on a narrow canvas', () => {
    render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId="n1"
        onSelectNode={() => {}}
        viewportWidth={390}
        orientation="lr"
      />,
    );
    expect(screen.getByTestId('loom-canvas')).toHaveAttribute('data-orientation', 'lr');
    expect(screen.queryByTestId('loom-path-strip')).not.toBeInTheDocument();
  });

  it('pans the graph when the canvas background is dragged with the mouse', () => {
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={() => {}} />);
    const surface = screen.getByTestId('loom-canvas');
    surface.scrollLeft = 120;
    surface.scrollTop = 60;

    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'mouse', clientX: 150, clientY: 170 });
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'mouse' });

    // The delta applies against the scroll offset captured at pointerdown.
    expect(surface.scrollLeft).toBe(170);
    expect(surface.scrollTop).toBe(90);
  });

  it('pans from a scene card on the stacked layout, where no card claims a drag', () => {
    const onMoveNode = vi.fn();
    render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={() => {}}
        onMoveNode={onMoveNode}
        viewportWidth={390}
      />,
    );
    const surface = screen.getByTestId('loom-canvas');
    expect(surface).toHaveAttribute('data-orientation', 'tb');
    const card = screen.getByLabelText('Scene: The Gate');

    fireEvent.pointerDown(card, { pointerId: 6, pointerType: 'mouse', button: 0, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(surface, { pointerId: 6, pointerType: 'mouse', clientX: 200, clientY: 220 });
    fireEvent.pointerUp(surface, { pointerId: 6, pointerType: 'mouse' });

    // Stacked cards span nearly the whole surface, so they must be pannable;
    // they must still never persist stacked coordinates as desktop `pos`.
    expect(surface.scrollTop).toBe(80);
    expect(onMoveNode).not.toHaveBeenCalled();
  });

  it('leaves a card drag to the card rather than panning the view', () => {
    const onMoveNode = vi.fn();
    const onSelectNode = vi.fn();
    render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        onMoveNode={onMoveNode}
      />,
    );
    const surface = screen.getByTestId('loom-canvas');
    const card = screen.getByLabelText('Scene: The Gate');
    surface.scrollLeft = 40;

    // The card captures the pointer, so the browser retargets the rest of the
    // gesture to it — fire there rather than on the surface.
    fireEvent.pointerDown(card, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 2, pointerType: 'mouse', clientX: 140, clientY: 130 });
    fireEvent.pointerUp(card, { pointerId: 2, pointerType: 'mouse' });

    expect(onMoveNode).toHaveBeenCalledWith('n1', expect.objectContaining({ x: expect.any(Number) }));
    expect(surface.scrollLeft).toBe(40);

    // Repositioning a card must not also select it — the click the drag ends
    // with is swallowed by the surface, wherever the browser retargets it.
    fireEvent.click(card);
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it('keeps a press that never moved a select, not a drag', () => {
    const onSelectNode = vi.fn();
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={onSelectNode} />);
    const surface = screen.getByTestId('loom-canvas');
    const card = screen.getByLabelText('Scene: The Gate');

    fireEvent.pointerDown(card, { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 3, pointerType: 'mouse', clientX: 102, clientY: 101 });
    fireEvent.pointerUp(card, { pointerId: 3, pointerType: 'mouse' });
    fireEvent.click(card);

    // Inside DRAG_THRESHOLD_PX, so nothing moved and the click still selects.
    expect(surface.scrollLeft).toBe(0);
    expect(onSelectNode).toHaveBeenCalledWith('n1');
  });

  it('swallows the click that ends a drag, wherever that click lands', () => {
    const onSelectNode = vi.fn();
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={onSelectNode} />);
    const surface = screen.getByTestId('loom-canvas');
    const label = screen.getByLabelText('Path: enter the gate');

    fireEvent.pointerDown(label, { pointerId: 4, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(surface, { pointerId: 4, pointerType: 'mouse', clientX: 240, clientY: 300 });
    fireEvent.pointerUp(surface, { pointerId: 4, pointerType: 'mouse' });
    fireEvent.click(label);

    expect(surface.scrollLeft).toBe(60);
    expect(onSelectNode).not.toHaveBeenCalled();

    // A cancelled gesture that never produced its click must not leave the
    // suppression armed and eat the next genuine select.
    fireEvent.pointerDown(surface, { pointerId: 5, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { pointerId: 5, pointerType: 'mouse', clientX: 60, clientY: 10 });
    fireEvent.pointerCancel(surface, { pointerId: 5, pointerType: 'mouse' });
    fireEvent.pointerDown(label, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(surface, { pointerId: 7, pointerType: 'mouse' });
    fireEvent.click(label);
    expect(onSelectNode).toHaveBeenCalledWith('n2');
  });

  it('ignores a touch drag on the background so the native scroll gesture survives', () => {
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={() => {}} />);
    const surface = screen.getByTestId('loom-canvas');
    surface.scrollTop = 25;

    fireEvent.pointerDown(surface, { pointerId: 8, pointerType: 'touch', button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerId: 8, pointerType: 'touch', clientX: 200, clientY: 120 });
    fireEvent.pointerUp(surface, { pointerId: 8, pointerType: 'touch' });

    expect(surface.scrollTop).toBe(25);
  });

  it('stacks the graph and shows a path strip on a narrow canvas', () => {
    const onSelectNode = vi.fn();
    render(
      <LoomCanvas
        episode={episode()}
        selectedNodeId="n1"
        onSelectNode={onSelectNode}
        viewportWidth={390}
      />,
    );
    expect(screen.getByTestId('loom-canvas')).toHaveAttribute('data-orientation', 'tb');
    expect(screen.getByTestId('loom-path-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enter the gate → Inside/i }));
    expect(onSelectNode).toHaveBeenCalledWith('n2');
  });
});
