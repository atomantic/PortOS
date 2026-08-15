import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// One file rather than three, because the assertion is a single cross-page
// contract: a tab body's lazy chunk arriving late must reserve the region's
// shape, not drop a centered BrailleSpinner into a tall empty box (#4147).
// Brain / Goals / DigitalTwin all need the same scaffolding (router param, a
// resolved data fetch, and a tab child that is still suspended), so splitting
// it three ways would be the same 40 lines of mocks copied three times.

// A lazily-imported tab body that never finishes rendering: throwing a promise
// that never settles is exactly what a still-downloading chunk does to React,
// so the page stays parked on its Suspense fallback.
// (`vi.mock` factories are hoisted above the module body, so each one builds
// its own suspending component rather than closing over a shared const.)
vi.mock('../components/brain/tabs/InboxTab', () => ({
  default: () => { throw new Promise(() => {}); },
}));
vi.mock('../components/goals/GoalsTreeView', () => ({
  default: () => { throw new Promise(() => {}); },
}));
vi.mock('../components/digital-twin/tabs/OverviewTab', () => ({
  default: () => { throw new Promise(() => {}); },
}));

vi.mock('../services/api', () => ({
  getBrainSummary: vi.fn(() => Promise.resolve({ counts: {}, needsReview: 0 })),
  getBrainSettings: vi.fn(() => Promise.resolve({})),
  getDigitalTwinStatus: vi.fn(() => Promise.resolve({ healthScore: 50, documentCount: 0, enabledDocuments: 0 })),
  getDigitalTwinSettings: vi.fn(() => Promise.resolve({})),
  getGoalsTree: vi.fn(() => Promise.resolve({ flat: [], tree: [] })),
}));

const renderAt = async (path, routePath, Page) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={<Page />} />
      </Routes>
    </MemoryRouter>
  );
  // The first-paint skeleton and the Suspense fallback are both `role=status`,
  // so wait for the fallback's specific label before asserting on it.
  return waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
};

describe('tab-body Suspense fallbacks reserve a skeleton, not a spinner (#4147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Brain reserves the tab region while the tab chunk is still loading', async () => {
    const { default: Brain } = await import('./Brain');
    await renderAt('/brain/inbox', '/brain/:tab', Brain);

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Loading brain section' })).toBeInTheDocument()
    );
    // The BrailleSpinner renders its frames as text; a skeleton reserves boxes.
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('Goals reserves the tree region while the tree chunk is still loading', async () => {
    const { default: Goals } = await import('./Goals');
    await renderAt('/goals/tree', '/goals/:tab', Goals);

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Loading goal tree' })).toBeInTheDocument()
    );
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('DigitalTwin reserves the section region while the section chunk is still loading', async () => {
    const { default: DigitalTwin } = await import('./DigitalTwin');
    await renderAt('/digital-twin/overview', '/digital-twin/:tab', DigitalTwin);

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Loading digital twin section' })).toBeInTheDocument()
    );
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });
});
