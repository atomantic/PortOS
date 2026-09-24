/**
 * Models page — tab routing only.
 *
 * Each tab's panel owns its own fetches (and has its own suite), so all of them
 * are stubbed here. What this file is about is the contract that makes them
 * reachable: `?tab` is a route param, so every panel is deep-linkable, and an
 * unknown slug lands somewhere real instead of rendering blank.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/models/ModelsTabsHeader';

vi.mock('../components/settings/LocalModelAssessments.jsx', () => ({
  default: ({ taskView, assessmentKey }) => (
    <div
      data-testid="assessments-panel"
      data-task-view={taskView || 'none'}
      data-assessment-key={assessmentKey || 'none'}
    >
      assessments panel
    </div>
  ),
}));
vi.mock('../components/settings/LocalLlmTab', () => ({
  LocalLlmTab: ({ view }) => <div data-testid="llms-view" data-view={view || 'none'}>llms panel</div>,
}));
vi.mock('../components/settings/LocalLlmRuntimesView.jsx', () => ({ default: ({ view }) => <div data-testid="runtime-panel" data-runtime={view || ''}>runtimes panel</div> }));
vi.mock('../components/settings/EmbeddingsTab', () => ({ default: () => <div>embeddings panel</div> }));
vi.mock('../components/models/Image3dRuntimes', () => ({ default: () => <div>3d runtimes panel</div> }));
vi.mock('../components/models/ModelStatusTab', () => ({ default: () => <div>status panel</div> }));
vi.mock('../components/models/SubscriptionsTab', () => ({ default: () => <div>subscriptions panel</div> }));
vi.mock('../components/settings/CodeReviewersTab', () => ({ default: () => <div>code reviewers panel</div> }));
vi.mock('../components/models/ModelComparison', () => ({ default: () => <div>comparison panel</div> }));
vi.mock('../components/models/DecisionClassifiers', () => ({ default: ({ view }) => <div>classifiers panel {view}</div> }));
vi.mock('./Loras', () => ({ default: () => <div>loras panel</div> }));
vi.mock('./LoraTraining', () => ({ default: () => <div>training panel</div> }));
vi.mock('./MediaModels', () => ({ default: () => <div>media models panel</div> }));
vi.mock('./LoraDatasetDetail', () => ({ default: ({ recordId }) => <div>dataset workbench {recordId}</div> }));

import Models from './Models';

// The marker each tab's stubbed panel renders. Keyed by tab id so the cases below
// are DERIVED from the header's TABS rather than re-listing the paths — a tab
// added to the header with no entry here fails the completeness check, instead of
// quietly going unrendered by a hand-maintained second list.
const PANEL_MARKER = {
  comparison: 'comparison panel',
  '3d': '3d runtimes panel',
  'code-reviewers': 'code reviewers panel',
  'decision-classifiers': 'classifiers panel',
  embeddings: 'embeddings panel',
  llms: 'llms panel',
  abuse: 'llms panel',
  jev: 'llms panel',
  'llms-runtimes': 'runtimes panel',
  loras: 'loras panel',
  media: 'media models panel',
  performance: 'assessments panel',
  status: 'status panel',
  subscriptions: 'subscriptions panel',
  training: 'training panel',
};

// These destinations belong to Models in the sidebar but keep their own route
// shells, so their pages render the shared header directly.
const EXTERNAL_TAB_IDS = ['harnesses', 'playground', 'providers', 'quota-burn', 'services', 'usage'];
const ownTabs = TABS.filter((t) => !EXTERNAL_TAB_IDS.includes(t.id));

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/models/performance/results/:assessmentKey" element={<Models fixedTab="performance" />} />
      <Route path="/models/performance/:view" element={<Models fixedTab="performance" />} />
      <Route path="/models/:tab" element={<Models />} />
      <Route path="/models/:tab/:recordId" element={<Models />} />
      <Route path="/models/decision-classifiers/jev/:taskView" element={<Models fixedTab="decision-classifiers" fixedRecordId="jev" />} />
      <Route path="/models/llms/jev/:taskView" element={<Models fixedTab="llms" fixedRecordId="jev" />} />
    </Routes>
  </MemoryRouter>
);

describe('Models', () => {
  it('names every destination served outside /models', () => {
    // Asserted by id, not as a count: a moved or newly promoted destination must
    // be identified here, not hidden by a count that still happens to match.
    expect(TABS.filter((t) => !t.to.startsWith('/models/')).map((t) => t.id).sort()).toEqual([...EXTERNAL_TAB_IDS].sort());
  });

  it('has a panel marker for every tab this page serves', () => {
    expect(ownTabs.map((t) => t.id).filter((id) => !PANEL_MARKER[id])).toEqual([]);
  });

  it.each(ownTabs.map((t) => [t.to, PANEL_MARKER[t.id]]))(
    'renders %s from the route param, not from local state',
    async (path, expected) => {
      renderAt(path);
      // `await`, not a sync get: the three panels moved in from the Media Gen tabs
      // are lazy chunks, so they resolve a tick after mount.
      expect(await screen.findByText(expected)).toBeInTheDocument();
    },
  );

  // A stale ⌘K entry or a typo must not produce a blank page; it follows the
  // same LLMs default as the bare route and primary navigation.
  it('redirects an unknown tab slug to LLMs', async () => {
    renderAt('/models/not-a-tab');
    expect(await screen.findByText('llms panel')).toBeInTheDocument();
  });

  it('titles the page with the destination instead of the Models section', async () => {
    renderAt('/models/code-reviewers');
    expect(screen.getByRole('heading', { level: 1, name: 'Code Reviewers' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Models' })).not.toBeInTheDocument();
    expect(await screen.findByText('code reviewers panel')).toBeInTheDocument();
  });

  it('keeps the destination title on a nested task view', () => {
    renderAt('/models/performance/capabilities');
    expect(screen.getByRole('heading', { level: 1, name: 'Performance' })).toBeInTheDocument();
  });

  it('uses the nested destination name for Abuse Guard', () => {
    renderAt('/models/llms/abuse');
    expect(screen.getByRole('heading', { level: 1, name: 'Abuse Guard' })).toBeInTheDocument();
  });

  it('passes an explicit Performance task view through the section shell', async () => {
    renderAt('/models/performance/capabilities');
    expect(await screen.findByTestId('assessments-panel')).toHaveAttribute('data-task-view', 'capabilities');
  });

  it('passes a selected assessment key through the results route', async () => {
    renderAt('/models/performance/results/v1-example');
    const panel = await screen.findByTestId('assessments-panel');
    expect(panel).toHaveAttribute('data-task-view', 'results');
    expect(panel).toHaveAttribute('data-assessment-key', 'v1-example');
  });

  // The slug comes straight off the URL, so a plain `TAB_CONTENT[tab]` lookup
  // resolves an Object.prototype member as a "valid" tab and hands it to React as
  // a component. These must take the unknown-slug path like any other typo.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'treats the inherited property %s as an unknown tab',
    async (slug) => {
      renderAt(`/models/${slug}`);
      expect(await screen.findByText('llms panel')).toBeInTheDocument();
    },
  );

  it('ignores a record id for a tab whose detail map inherits the name', async () => {
    // Same hazard one level down: `TAB_DETAIL['constructor']` is a function, so an
    // unguarded lookup would render it instead of falling back to the tab index.
    renderAt('/models/loras/anything');
    expect(await screen.findByText('loras panel')).toBeInTheDocument();
  });

  it('offers every Models destination in the sub-nav', () => {
    renderAt('/models/performance');
    for (const { label } of TABS) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  // The tab bar collapses to an icon row under `sm` — this section is now too
  // wide for a phone pill row — so every destination has to stay reachable and
  // named there, with an icon of its own to be reachable BY.
  it('keeps every destination in the phone icon row, named and drawn', () => {
    renderAt('/models/performance');
    const bar = screen.getByRole('tablist', { name: 'Models sections' });
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(TABS.map((t) => t.label));
    expect(tabs.every((t) => t.querySelector('svg') && t.querySelector('.max-sm\\:sr-only'))).toBe(true);
  });

  // A tab listed in the header but missing from TAB_CONTENT falls through to the
  // unknown-slug redirect and silently lands on LLMs. Selection state is what
  // distinguishes "rendered this tab" from "bounced to LLMs" — the
  // per-path cases above can't see it, because a bounced tab still renders A panel.
  it('serves every /models tab the header advertises, without bouncing to LLMs', () => {
    for (const tab of ownTabs) {
      const { unmount } = renderAt(tab.to);
      expect(screen.getByRole('tab', { name: tab.label })).toHaveAttribute('aria-selected', 'true');
      unmount();
    }
  });
});

describe('Models — tab drill-downs', () => {
  // #7414 moved Runtimes out of the pill bar and onto its own tab. Which view
  // the bare `/models/llms` route falls back to is LocalLlmTab's contract and is
  // asserted there; what this page owes is that Runtimes no longer routes
  // THROUGH the LLMs dispatcher at all.
  it('serves Runtimes as its own tab rather than an LLMs sub-view', async () => {
    renderAt('/models/llms-runtimes');
    expect(await screen.findByText('runtimes panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Runtimes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('llms-view')).not.toBeInTheDocument();
  });

  it('preserves the Runtimes navigation identity when selecting a runtime', async () => {
    renderAt('/models/llms-runtimes/slotstream');
    expect(await screen.findByTestId('runtime-panel')).toHaveAttribute('data-runtime', 'slotstream');
    expect(screen.getByRole('tab', { name: 'Runtimes' })).toHaveAttribute('aria-selected', 'true');
  });

  it.each(['library', 'abuse'])('passes the LLM %s sub-route through to the focused LLM view', async (view) => {
    renderAt(`/models/llms/${view}`);
    expect(await screen.findByTestId('llms-view')).toHaveAttribute('data-view', view);
    expect(screen.getByRole('tab', { name: view === 'library' ? 'Model Library' : 'Abuse Guard' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders a tab detail view INSIDE the section shell, not as a bare page', async () => {
    // Under /media these pages kept the shell's chrome for free, because MediaGen
    // was a layout route. Registering the workbench as its own top-level route
    // would silently drop the section header and tab bar; asserting the tab bar is
    // still present (and still marks Training active) is what catches that.
    renderAt('/models/training/dataset-abc');
    expect(await screen.findByText('dataset workbench dataset-abc')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Training' })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to the tab index when the tab has no detail view', async () => {
    // A tab that does not recognize the focused sub-view id should still land on
    // something real rather than 404. LLMs consumes this segment; LoRAs does not.
    renderAt('/models/loras/some-id');
    expect(await screen.findByText('loras panel')).toBeInTheDocument();
  });
});

it('redirects the old Jev URL into Decision Classifiers', async () => {
    renderAt('/models/llms/jev');
    expect(await screen.findByText('classifiers panel jev')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Decision Classifiers' })).toHaveAttribute('aria-selected', 'true');
});

it('keeps the Jev task legacy alias within the Decision Classifiers host', async () => {
  renderAt('/models/llms/jev/results');
  expect(await screen.findByText('classifiers panel jev')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Decision Classifiers' })).toHaveAttribute('aria-selected', 'true');
});
