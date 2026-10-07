import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PublishCard from './PublishCard.jsx';

const card = (props = {}) => (
  <PublishCard projectId="mv-1" cardId="assets" label="Release assets" summary="Built" {...props}>
    <p>Card body</p>
  </PublishCard>
);

describe('PublishCard', () => {
  beforeEach(() => localStorage.clear());

  it('opens by default and folds to its header with the summary beside it', () => {
    render(card());
    const toggle = screen.getByRole('button', { name: /Release assets/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Card body')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Card body')).not.toBeVisible(); // folded, still mounted for deep links
    expect(screen.getByText('Built')).toBeInTheDocument();
  });

  it('starts folded when it needs nothing, and remembers a toggle per project', () => {
    const { unmount } = render(card({ defaultOpen: false }));
    expect(screen.getByText('Card body')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Release assets/ }));
    unmount();
    const { unmount: unmountAgain } = render(card({ defaultOpen: false }));
    expect(screen.getByText('Card body')).toBeVisible();
    unmountAgain();
    // another project keeps its own default
    render(card({ projectId: 'mv-2', defaultOpen: false }));
    expect(screen.getByText('Card body')).not.toBeVisible();
  });

  it('keeps header actions outside the fold toggle', () => {
    render(card({ actions: <button type="button">Rebuild kit</button> }));
    fireEvent.click(screen.getByRole('button', { name: /Release assets/ }));
    expect(screen.getByRole('button', { name: 'Rebuild kit' })).toBeInTheDocument();
  });
});
