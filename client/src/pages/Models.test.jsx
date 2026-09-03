/**
 * Models page — tab routing only.
 *
 * Each tab's panel owns its own fetches (and has its own suite), so all of them
 * are stubbed here. What this file is about is the contract that makes them
 * reachable: `?tab` is a route param, so every panel is deep-linkable, and an
 * unknown slug lands somewhere real instead of rendering blank.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/models/ModelsTabsHeader';

vi.mock('../components/settings/LocalModelAssessments.jsx', () => ({ default: () => <div>assessments panel</div> }));
vi.mock('../components/settings/LocalLlmTab', () => ({
  LocalLlmTab: ({ view }) => <div data-testid="llms-view" data-view={view || 'runtimes'}>llms panel</div>,
}));
vi.mock('../components/settings/EmbeddingsTab', () => ({ default: () => <div>embeddings panel</div> }));
vi.mock('../components/models/Image3dRuntimes', () => ({ default: () => <div>3d runtimes panel</div> }));
vi.mock('../components/models/ModelStatusTab', () => ({ default: () => <div>status panel</div> }));
vi.mock('../components/settings/CodeReviewersTab', () => ({ default: () => <div>code reviewers panel</div> }));
vi.mock('../components/models/HarnessesTab', () => ({ default: () => <div>harnesses panel</div> }));
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
  '3d': '3d runtimes panel',
  'code-reviewers': 'code reviewers panel',
  embeddings: 'embeddings panel',
  harnesses: 'harnesses panel',
  llms: 'llms panel',
  loras: 'loras panel',
  media: 'media models panel',
  performance: 'assessments panel',
  status: 'status panel',
  training: 'training panel',
};

// Playground is the one destination the header lists that this page does not
// serve — it predates the section and keeps its own `/local-llm/playground` path.
const EXTERNAL_TAB_IDS = ['playground'];
const ownTabs = TABS.filter((t) => !EXTERNAL_TAB_IDS.includes(t.id));

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/models/:tab" element={<Models />} />
      <Route path="/models/:tab/:recordId" element={<Models />} />
    </Routes>
  </MemoryRouter>
);

describe('Models', () => {
  it('names the one destination served outside /models', () => {
    // Asserted by id, not as a count: the day a second external destination joins
    // the header, this should say WHICH one appeared, not just that a number moved.
    expect(TABS.filter((t) => !t.to.startsWith('/models/')).map((t) => t.id)).toEqual(EXTERNAL_TAB_IDS);
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

  // The tab bar collapses to a `<select>` under `sm`, so every destination has to
  // be reachable there too — nine tabs no longer fit a phone-width pill row.
  it('mirrors every destination into the mobile select', () => {
    renderAt('/models/performance');
    const select = screen.getByRole('combobox', { name: 'Models sections' });
    expect([...select.options].map((o) => o.textContent)).toEqual(TABS.map((t) => t.label));
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
  it.each(['library', 'abuse'])('passes the LLM %s sub-route through to the focused LLM view', async (view) => {
    renderAt(`/models/llms/${view}`);
    expect(await screen.findByTestId('llms-view')).toHaveAttribute('data-view', view);
    expect(screen.getByRole('tab', { name: 'LLMs' })).toHaveAttribute('aria-selected', 'true');
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
