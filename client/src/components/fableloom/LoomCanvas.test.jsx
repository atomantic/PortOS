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

describe('LoomCanvas', () => {
  it('renders scene cards with start/ending markers and edge intent labels', () => {
    render(<LoomCanvas episode={episode()} selectedNodeId={null} onSelectNode={() => {}} />);
    expect(screen.getByLabelText('Scene: The Gate')).toBeInTheDocument();
    expect(screen.getByLabelText('Scene: Inside')).toBeInTheDocument();
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.getByText('Within')).toBeInTheDocument();
    expect(screen.getByText('enter the gate')).toBeInTheDocument();
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
