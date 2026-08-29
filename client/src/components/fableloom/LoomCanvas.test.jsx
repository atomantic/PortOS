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
      />,
    );

    expect(screen.getByLabelText('The Gate video preview')).toBeInTheDocument();
    expect(screen.queryByAltText('The Gate image preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate video' }));
    expect(onGenerateImage).toHaveBeenCalledWith(withMedia.nodes[0]);
    expect(onGenerateVideo).toHaveBeenCalledWith(withMedia.nodes[0]);
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
