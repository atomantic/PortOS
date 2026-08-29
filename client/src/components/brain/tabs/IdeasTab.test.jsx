import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

// The two views are covered by their own suites; this one proves the Ideas tab
// mounts BOTH of them and that the active view is addressable from the URL.
vi.mock('./MemoryTab', () => ({
  default: ({ fixedType }) => <div data-testid="memory-tab">native:{fixedType}</div>,
}));
vi.mock('../IdeaLoomLists', () => ({
  default: () => <div data-testid="idealoom-lists">idealoom</div>,
}));

import IdeasTab from './IdeasTab';

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderTab(entry = '/brain/ideas') {
  return render(<MemoryRouter initialEntries={[entry]}><IdeasTab onRefresh={() => {}} /><Location /></MemoryRouter>);
}

describe('IdeasTab', () => {
  it('defaults to the native Brain ideas view', () => {
    renderTab();
    expect(screen.getByTestId('memory-tab').textContent).toBe('native:ideas');
    expect(screen.queryByTestId('idealoom-lists')).toBeNull();
  });

  it('opens the IdeaLoom lists view straight from the URL', () => {
    renderTab('/brain/ideas?view=lists&list=list-1');
    expect(screen.getByTestId('idealoom-lists')).toBeTruthy();
    expect(screen.queryByTestId('memory-tab')).toBeNull();
  });

  it('records the selected view in the URL rather than local state', () => {
    renderTab();
    fireEvent.click(screen.getByRole('tab', { name: 'IdeaLoom lists' }));
    expect(screen.getByTestId('location').textContent).toBe('?view=lists');
    expect(screen.getByTestId('idealoom-lists')).toBeTruthy();
  });

  it('drops the IdeaLoom list selection when switching back to native ideas', () => {
    renderTab('/brain/ideas?view=lists&list=list-1');
    fireEvent.click(screen.getByRole('tab', { name: 'Brain ideas' }));
    expect(screen.getByTestId('location').textContent).toBe('');
    expect(screen.getByTestId('memory-tab')).toBeTruthy();
  });

  // Regression guard: the panel shipped once with no caller at all, which left
  // the whole IdeaLoom experience unreachable in the running app.
  it('is the component the Brain page renders for its ideas tab', () => {
    const clientSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const brainPage = readFileSync(join(clientSrc, 'pages', 'Brain.jsx'), 'utf8');
    expect(brainPage).toContain("import('../components/brain/tabs/IdeasTab')");
    expect(brainPage).toMatch(/case 'ideas':\s*\n\s*return <IdeasTab /);
  });
});
