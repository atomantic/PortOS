import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ManuscriptHighlightedProse from './ManuscriptHighlightedProse';

const CONTENT = 'line one ANCHOR tail\nline two\nline three';
const SPANS = [{ commentId: 'c1', severity: 'high', start: CONTENT.indexOf('ANCHOR'), end: CONTENT.indexOf('ANCHOR') + 'ANCHOR'.length }];

describe('ManuscriptHighlightedProse', () => {
  it('renders the content verbatim with a clickable highlight', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ManuscriptHighlightedProse content={CONTENT} spans={SPANS} openCommentId={null} onOpenComment={onOpen} />,
    );
    expect(container.textContent).toBe(CONTENT);
    fireEvent.click(screen.getByText('ANCHOR'));
    expect(onOpen).toHaveBeenCalledWith('c1');
  });

  it('injects the inline card at the end of the line containing the open note anchor', () => {
    const { container } = render(
      <ManuscriptHighlightedProse
        content={CONTENT}
        spans={SPANS}
        openCommentId="c1"
        onOpenComment={() => {}}
        inlineCard={<div data-testid="card">CARD</div>}
      />,
    );
    expect(screen.getByTestId('card')).toBeInTheDocument();
    const text = container.textContent;
    // The card splices in after the anchor's line, before the following line.
    expect(text.indexOf('CARD')).toBeGreaterThan(text.indexOf('ANCHOR tail'));
    expect(text.indexOf('CARD')).toBeLessThan(text.indexOf('line two'));
    // The prose itself is still intact around the card.
    expect(text.replace('CARD', '')).toBe(CONTENT);
  });

  it('appends the card at the end when the open note has no located span', () => {
    const { container } = render(
      <ManuscriptHighlightedProse
        content={CONTENT}
        spans={SPANS}
        openCommentId="c-unlocated"
        onOpenComment={() => {}}
        inlineCard={<div data-testid="card">CARD</div>}
      />,
    );
    expect(container.textContent.endsWith('CARD')).toBe(true);
  });

  it('renders no card when inlineCard is absent', () => {
    render(
      <ManuscriptHighlightedProse content={CONTENT} spans={SPANS} openCommentId="c1" onOpenComment={() => {}} />,
    );
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
  });
});
