vi.mock('../services/apiMusic.js', () => ({ listMusicEngines: vi.fn(() => Promise.resolve({ engines: [] })) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

vi.mock('../services/apiCreativeDirector.js', () => ({
  listCreativeDirectorProjects: vi.fn(() => Promise.resolve([])),
  updateCreativeDirectorProject: vi.fn(() => Promise.resolve({})),
  createCreativeDirectorProject: vi.fn(() => Promise.resolve({})),
  createSmokeTestCreativeDirectorProject: vi.fn(() => Promise.resolve({ id: 'smoke-1', name: 'CD smoke test (colored ball)', status: 'planning' })),
  deleteCreativeDirectorProject: vi.fn(() => Promise.resolve({})),
  startCreativeDirectorProject: vi.fn(() => Promise.resolve({})),
  pauseCreativeDirectorProject: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../services/apiCatalog.js', () => ({ listCatalogIngredients: vi.fn(() => Promise.resolve([])), listCatalogIngredientsByIds: vi.fn(() => Promise.resolve([])) }));
vi.mock('../services/apiImageVideo.js', () => ({ listVideoModels: vi.fn(() => Promise.resolve([{ id: 'model-a', name: 'Model A' }])) }));
vi.mock('../services/apiUniverseBuilder.js', () => ({ listUniverses: vi.fn(() => Promise.resolve([])) }));
vi.mock('../services/apiPipeline.js', () => ({ listPipelineSeries: vi.fn(() => Promise.resolve([])) }));
vi.mock('../components/creative-director/CreativeDirectorModelsDrawer.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import * as cdApi from '../services/apiCreativeDirector.js';
import CreativeDirector from './CreativeDirector';

const MENU_LABEL = 'More Creative Director actions';
const ITEM_LABEL = 'Render a 6s test clip';
const CONFIRM_LABEL = 'Render test clip';

const renderPage = async () => {
  render(<MemoryRouter><CreativeDirector /></MemoryRouter>);
  await screen.findByRole('button', { name: 'New project' });
};

const openMenu = async (user) => {
  await user.click(screen.getByRole('button', { name: MENU_LABEL }));
};

describe('CreativeDirector header action hierarchy (#3287)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdApi.listCreativeDirectorProjects.mockResolvedValue([]);
    cdApi.createSmokeTestCreativeDirectorProject.mockResolvedValue({ id: 'smoke-1', name: 'CD smoke test (colored ball)', status: 'planning' });
  });

  it('keeps the smoke test out of the resting header bar', async () => {
    await renderPage();

    expect(screen.queryByRole('button', { name: /smoke test/i })).toBeNull();
    expect(screen.queryByRole('button', { name: ITEM_LABEL })).toBeNull();
    // The bar itself is New directive · Model defaults · … · New project.
    expect(screen.getByRole('button', { name: 'New directive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model defaults' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: MENU_LABEL })).toBeTruthy();
  });

  it('exposes the test-clip render only through the overflow menu, labelled by outcome', async () => {
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: ITEM_LABEL })).toBeTruthy();
  });

  it('does not spend render budget until the inline confirm is accepted', async () => {
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: ITEM_LABEL }));

    expect(cdApi.createSmokeTestCreativeDirectorProject).not.toHaveBeenCalled();
    expect(screen.getByText(/spends real render time/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));
    await waitFor(() => expect(cdApi.createSmokeTestCreativeDirectorProject).toHaveBeenCalledTimes(1));
    // The confirm is consumed by the run, not left armed.
    expect(screen.queryByRole('button', { name: CONFIRM_LABEL })).toBeNull();
  });

  it('cancelling the confirm runs nothing and returns focus to the "…" trigger', async () => {
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: ITEM_LABEL }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(cdApi.createSmokeTestCreativeDirectorProject).not.toHaveBeenCalled();
    expect(screen.queryByText(/spends real render time/i)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: MENU_LABEL }));
  });

  it('returns focus to the "…" trigger after confirming, instead of stranding it on <body>', async () => {
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: ITEM_LABEL }));
    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    await waitFor(() => expect(cdApi.createSmokeTestCreativeDirectorProject).toHaveBeenCalled());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: MENU_LABEL }));
  });

  it('adds the started test-clip project to the list', async () => {
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: ITEM_LABEL }));
    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    await screen.findByText('CD smoke test (colored ball)');
  });

  it('leaves the list untouched when the render fails to start', async () => {
    cdApi.createSmokeTestCreativeDirectorProject.mockRejectedValue(new Error('no video model'));
    const user = userEvent.setup();
    await renderPage();

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: ITEM_LABEL }));
    await user.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    await waitFor(() => expect(cdApi.createSmokeTestCreativeDirectorProject).toHaveBeenCalled());
    // Menu item is re-enabled so the user can retry after fixing the model.
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('menuitem', { name: ITEM_LABEL }).disabled).toBe(false));
  });
});


describe('Video workspace draft creation', () => {
  it('saves an inert draft and links existing project IDs within Creative Director', async () => {
    const user = userEvent.setup();
    vi.clearAllMocks();
    cdApi.listCreativeDirectorProjects.mockResolvedValue([{ id: 'existing-project', name: 'Existing project', status: 'draft', workspace: 'video' }]);
    cdApi.createCreativeDirectorProject.mockResolvedValue({ id: 'new-draft', name: 'Example short', workspace: 'video', status: 'draft' });
    render(<MemoryRouter initialEntries={['/creative-director']}><CreativeDirector /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'New video draft' }));
    expect(screen.getByRole('link', { name: 'Open Existing project' })).toHaveAttribute('href', '/creative-director/existing-project/overview');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    await user.type(screen.getByLabelText('Name'), 'Example short');
    await user.type(screen.getByRole('textbox', { name: 'Brief' }), 'A traveler returns home.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(cdApi.createCreativeDirectorProject).toHaveBeenCalledWith(expect.objectContaining({
      workspace: 'video', name: 'Example short', userStory: 'A traveler returns home.',
      videoDraft: expect.objectContaining({ durationRange: { min: 30, max: 60 }, reviewPolicy: 'review', checkpoints: ['script-shot-plan', 'references', 'rough-cut', 'final-cut'] }),
    }), { silent: true }));
    expect(cdApi.startCreativeDirectorProject).not.toHaveBeenCalled();
  });
});

it.each(['/creative-director', '/video'])('keeps a Video remix from %s open and forwards source IDs once on save', async pathname => {
  vi.clearAllMocks();
  cdApi.listCreativeDirectorProjects.mockResolvedValue([]);
  cdApi.createCreativeDirectorProject.mockResolvedValue({ id: 'remix-draft', name: 'Example remix', workspace: 'video', status: 'draft' });
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[{ pathname, search: '?view=all&new=video', hash: '#drafts', state: { remix: { ingredientIds: ['source-example'] } } }]}><Routes><Route path="/video" element={<CreativeDirector browseOnly />} /><Route path="/creative-director" element={<CreativeDirector />} /><Route path="/creative-director/:id/overview" element={<div>Saved draft</div>} /></Routes></MemoryRouter>);
  await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Example remix');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(cdApi.createCreativeDirectorProject).toHaveBeenCalledTimes(1));
  expect(cdApi.createCreativeDirectorProject).toHaveBeenCalledWith(expect.objectContaining({ catalogIngredientIds: ['source-example'], videoDraft: expect.objectContaining({ sources: [{ kind: 'catalog', id: 'source-example' }] }) }), { silent: true });
});


it('keeps Video as a browsing surface and sends production actions to Creative Director', async () => {
  vi.clearAllMocks();
  cdApi.listCreativeDirectorProjects.mockResolvedValue([{ id: 'commission-video', name: 'Example commission video', status: 'complete', commissionId: 'example-commission' }]);
  render(<MemoryRouter initialEntries={['/video']}><CreativeDirector browseOnly /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Open Example commission video' })).toHaveAttribute('href', '/creative-director/commission-video/overview');
  expect(screen.getByRole('link', { name: 'Open Creative Director' })).toHaveAttribute('href', '/creative-director');
  expect(screen.queryByRole('button', { name: /New|Start|Delete|Model defaults/ })).toBeNull();
  expect(cdApi.createCreativeDirectorProject).not.toHaveBeenCalled();
  expect(cdApi.startCreativeDirectorProject).not.toHaveBeenCalled();
});
