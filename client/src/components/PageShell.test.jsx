import { lazy } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FullWidthMain, PaddedMain } from './PageShell';

const Pending = lazy(() => new Promise(() => {}));

describe.each([['full', FullWidthMain], ['padded', PaddedMain]])('%s shell', (shell, Shell) => {
  it('keeps the main landmark and sibling chrome mounted while a lazy route is pending', () => {
    render(
      <MemoryRouter initialEntries={['/x']}>
        <nav aria-label="sidebar" />
        <Routes>
          <Route element={<Shell />}>
            <Route path="x" element={<Pending />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('data-shell', shell);
    expect(main).toHaveTextContent('Loading');
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeInTheDocument();
  });
});
