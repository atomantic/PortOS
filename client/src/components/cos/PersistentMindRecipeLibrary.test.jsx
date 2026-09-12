import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import PersistentMindRecipeLibrary from './PersistentMindRecipeLibrary';

const api = vi.hoisted(() => ({
  getMindRecipes: vi.fn(), getMindRecipe: vi.fn(), createMindRecipe: vi.fn(),
  updateMindRecipe: vi.fn(), validateMindRecipe: vi.fn(), archiveMindRecipe: vi.fn(), restoreMindRecipe: vi.fn(),
}));
vi.mock('../../services/api', () => api);
const definition = { schemaVersion: 1, name: 'recipe.project-checkin', purpose: 'Project summary', parameters: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'goals', tool: 'goals.list', arguments: {} }], outputs: { goals: { step: 'goals', path: [] } } };
const recipe = (overrides = {}) => ({ id: 'first', name: definition.name, activeRevision: 1, definition, archived: false, available: true, updatedAt: '2026-09-12T00:00:00Z', ...overrides });
const detail = (entry) => ({ recipe: entry, versions: [{ revision: entry.activeRevision, definition: entry.definition, author: 'user', createdAt: entry.updatedAt }] });
function TestPage() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.search}</output><button type="button" onClick={() => navigate('/cos/mind?panel=tools&recipe=second')}>Navigate to second</button><PersistentMindRecipeLibrary /></>;
}
const renderPage = (search = '?panel=tools') => render(<MemoryRouter initialEntries={[`/cos/mind${search}`]}><TestPage /></MemoryRouter>);
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

beforeEach(() => {
  vi.resetAllMocks();
  api.getMindRecipes.mockResolvedValue({ recipes: [] });
  api.getMindRecipe.mockImplementation(async (id) => detail(recipe({ id, name: id === 'second' ? 'recipe.second' : definition.name })));
  api.validateMindRecipe.mockResolvedValue({ valid: true, runtimeChecks: [{ field: 'steps.0.arguments', step: 'goals', message: 'Output bindings are checked at invocation.' }] });
  api.createMindRecipe.mockResolvedValue(recipe());
});

describe('PersistentMindRecipeLibrary', () => {
  it('creates from an editable example, validates without execution, and preserves the panel link', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/No saved recipes/)).toBeInTheDocument();
    expect(screen.getByText(/with Mind grants off/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New recipe' }));
    expect(JSON.parse(screen.getByLabelText('Recipe definition (JSON)').value).name).toBe('recipe.project-checkin');
    await user.click(screen.getByRole('button', { name: 'Validate definition' }));
    expect(await screen.findByText('Definition valid. Validation does not run tools.')).toBeInTheDocument();
    expect(screen.getByText(/Output bindings are checked at invocation/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save recipe' }));
    expect(await screen.findByRole('button', { name: definition.name })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('?panel=tools&recipe=first');
    expect(api.getMindRecipes).toHaveBeenCalledTimes(2);
    expect(api.createMindRecipe).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 1, name: definition.name }), { silent: true });
  });

  it('preserves invalid drafts and revision conflicts, and saves the expected revision', async () => {
    const user = userEvent.setup();
    renderPage('?panel=tools&recipe=first');
    const editor = await screen.findByLabelText('Recipe definition (JSON)');
    fireEvent.change(editor, { target: { value: '{bad' } });
    await user.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText('Recipe could not be completed')).toBeInTheDocument();
    expect(api.updateMindRecipe).not.toHaveBeenCalled();
    const changed = { ...definition, purpose: 'Updated purpose' };
    fireEvent.change(editor, { target: { value: JSON.stringify(changed) } });
    api.validateMindRecipe.mockRejectedValueOnce(Object.assign(new Error('Read tool is unavailable'), { context: { field: 'steps.0.tool', step: 'goals' } }));
    await user.click(screen.getByRole('button', { name: 'Validate definition' }));
    expect(await screen.findByText(/steps.0.tool · step goals: Read tool is unavailable/)).toBeInTheDocument();
    expect(editor).toHaveValue(JSON.stringify(changed));
    api.validateMindRecipe.mockRejectedValueOnce(Object.assign(new Error('Validation failed'), { context: { details: [{ path: ['definition', 'parameters', 'additionalProperties'], message: 'Must be false' }] } }));
    await user.click(screen.getByRole('button', { name: 'Validate definition' }));
    expect(await screen.findByText(/definition.parameters.additionalProperties: Must be false/)).toBeInTheDocument();
    api.updateMindRecipe.mockRejectedValueOnce(Object.assign(new Error('Revision conflict'), { status: 409 }));
    await user.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText(/copy your draft first/)).toBeInTheDocument();
    expect(editor).toHaveValue(JSON.stringify(changed));
    expect(api.updateMindRecipe).toHaveBeenCalledWith('first', { expectedRevision: 1, definition: changed }, { silent: true });
    api.updateMindRecipe.mockResolvedValueOnce(recipe({ definition: changed, activeRevision: 2 }));
    await user.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(await screen.findByText(/Revision 2 · user/)).toBeInTheDocument();
  });

  it('archives and restores history as a new revision with immediate list updates', async () => {
    const user = userEvent.setup();
    api.getMindRecipes.mockResolvedValue({ recipes: [recipe()] });
    api.archiveMindRecipe.mockResolvedValue(recipe({ archived: true, available: false, activeRevision: 2 }));
    api.restoreMindRecipe.mockResolvedValue(recipe({ activeRevision: 3 }));
    renderPage('?panel=tools&recipe=first');
    await user.click(await screen.findByRole('button', { name: 'Archive recipe' }));
    expect(await screen.findByText(/Restore a revision below/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save new revision' })).toBeDisabled();
    expect(api.archiveMindRecipe).toHaveBeenCalledWith('first', 1, { silent: true });
    await user.click(screen.getByRole('button', { name: 'Restore revision 1' }));
    expect(await screen.findByText(/Revision 3 · user/)).toBeInTheDocument();
    expect(api.restoreMindRecipe).toHaveBeenCalledWith('first', { expectedRevision: 2, revision: 1 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Save new revision' })).toBeEnabled();
    expect(within(screen.getByRole('list')).getByText('Revision 3 · Saved')).toBeInTheDocument();
    expect(api.getMindRecipes).toHaveBeenCalledTimes(3);
  });

  it('ignores stale detail and save responses when the URL selection changes', async () => {
    const user = userEvent.setup();
    const lateDetail = deferred();
    api.getMindRecipe.mockImplementationOnce(() => lateDetail.promise);
    renderPage('?panel=tools&recipe=first');
    await user.click(screen.getByRole('button', { name: 'Navigate to second' }));
    const editor = await screen.findByLabelText('Recipe definition (JSON)');
    await act(async () => lateDetail.resolve(detail(recipe())));
    expect(screen.getByRole('heading', { name: 'recipe.second' })).toBeInTheDocument();
    const lateSave = deferred();
    api.updateMindRecipe.mockReturnValueOnce(lateSave.promise);
    await user.click(screen.getByRole('button', { name: 'Save new revision' }));
    expect(editor).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Close editor' }));
    await user.click(screen.getByRole('button', { name: 'New recipe' }));
    await act(async () => lateSave.resolve(recipe({ id: 'second', activeRevision: 2 })));
    expect(screen.getByRole('heading', { name: 'New recipe' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('recipe=new');
    expect(screen.queryByText(/Revision 2 · user/)).not.toBeInTheDocument();
  });

  it('updates the list when creation completes after closing its editor without reopening it', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred();
    api.createMindRecipe.mockReturnValueOnce(pendingSave.promise);
    renderPage('?panel=tools&recipe=new');
    await screen.findByText(/No saved recipes/);
    await user.click(screen.getByRole('button', { name: 'Save recipe' }));
    await user.click(screen.getByRole('button', { name: 'Close editor' }));
    await act(async () => pendingSave.resolve(recipe()));
    expect(await screen.findByRole('button', { name: definition.name })).toBeInTheDocument();
    expect(screen.queryByLabelText('Recipe definition (JSON)')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('?panel=tools');
    expect(api.getMindRecipes).toHaveBeenCalledTimes(2);
    expect(api.getMindRecipe).not.toHaveBeenCalled();
  });

  it('does not refresh the library when a pending save completes after the panel unmounts', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred();
    api.createMindRecipe.mockReturnValueOnce(pendingSave.promise);
    const view = renderPage('?panel=tools&recipe=new');
    await screen.findByText(/No saved recipes/);
    await user.click(screen.getByRole('button', { name: 'Save recipe' }));
    view.unmount();
    await act(async () => pendingSave.resolve(recipe()));
    expect(api.getMindRecipes).toHaveBeenCalledTimes(1);
    expect(api.getMindRecipe).not.toHaveBeenCalled();
  });

  it('keeps newer saved rows and unrelated recipes when an earlier library read finishes', async () => {
    const user = userEvent.setup();
    const lateList = deferred();
    api.getMindRecipes.mockReturnValueOnce(lateList.promise)
      .mockResolvedValueOnce({ recipes: [recipe(), recipe({ id: 'second', name: 'recipe.second' })] });
    api.archiveMindRecipe.mockResolvedValue(recipe({ activeRevision: 2, archived: true }));
    renderPage('?panel=tools&recipe=first');
    await user.click(await screen.findByRole('button', { name: 'Archive recipe' }));
    await screen.findByText(/Restore a revision below/);
    await act(async () => lateList.resolve({ recipes: [recipe(), recipe({ id: 'second', name: 'recipe.second' })] }));
    const list = within(screen.getByRole('list'));
    expect(list.getByText('Revision 2 · Archived')).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'recipe.second' })).toBeInTheDocument();
  });

  it('shows lookup failures and retries instead of treating them as an empty library', async () => {
    const user = userEvent.setup();
    api.getMindRecipes.mockRejectedValueOnce(new Error('Database unavailable'));
    api.getMindRecipe.mockRejectedValueOnce(Object.assign(new Error('Missing'), { status: 404 }));
    renderPage('?panel=tools&recipe=missing');
    expect(await screen.findByText(/Recipe not found/)).toBeInTheDocument();
    expect(screen.getByText(/Database unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No saved recipes/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry library' }));
    await waitFor(() => expect(screen.getByText(/No saved recipes/)).toBeInTheDocument());
  });
});
