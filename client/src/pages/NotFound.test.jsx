import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import NotFound from './NotFound';

describe('NotFound', () => {
  it('names the route that did not match instead of silently redirecting', () => {
    render(
      <MemoryRouter initialEntries={['/annotate?x=1#frag']}>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByText("That page doesn't exist")).toBeInTheDocument();
    expect(screen.getByText('/annotate?x=1#frag')).toBeInTheDocument();
  });

  it('offers a way forward (back + dashboard)', () => {
    render(
      <MemoryRouter initialEntries={['/nope']}>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/');
  });
});
