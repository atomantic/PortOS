import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import MemoryTab from './MemoryTab';

const api = vi.hoisted(() => ({
  getBrainMemories: vi.fn(), getBrainMemory: vi.fn(), updateBrainMemory: vi.fn(),
  getBrainPeople: vi.fn(), updateBrainPerson: vi.fn(),
  getMemoryBackendStatus: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const memory = (id, extra = {}) => ({ id, title: `Example ${id}`, content: `Full body ${id}`, tags: [], ...extra });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function mount(rows) {
  api.getBrainMemories.mockResolvedValue(rows);
  render(<MemoryRouter initialEntries={['/brain/memory']}><Routes>
    <Route path="/brain/:tab/:recordType?/:recordId?" element={<MemoryTab />} />
  </Routes></MemoryRouter>);
  await screen.findByRole('button', { name: `Read ${rows[0].title}` });
}
function edit(title) {
  const row = screen.getByRole('button', { name: `Read ${title}` }).closest('.p-4');
  fireEvent.click(within(row).getByRole('button', { name: 'Edit', exact: true }));
}
beforeEach(() => {
  vi.resetAllMocks();
  api.getMemoryBackendStatus.mockResolvedValue({ backend: 'postgres' });
});
afterEach(() => cleanup());

describe('Brain record editor ownership', () => {
  it('cannot save a truncated preview, and offers retry before editing after a failed full read', async () => {
    const full = deferred();
    api.getBrainMemory.mockReturnValueOnce(full.promise).mockResolvedValueOnce(memory('a'));
    await mount([memory('a', { content: 'Preview only', contentTruncated: true })]);
    edit('Example a');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'What happened' })).toBeNull();
    await act(async () => { full.reject(new Error('Read failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this entry for editing");
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(api.updateBrainMemory).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByRole('textbox', { name: 'What happened' })).toHaveValue('Full body a');
    api.updateBrainMemory.mockResolvedValue(memory('a', { content: 'Complete edited body' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What happened' }), { target: { value: 'Complete edited body' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true })); });
    expect(api.updateBrainMemory).toHaveBeenCalledWith('a', expect.objectContaining({ content: 'Complete edited body' }), { silent: true });
    expect(screen.getByRole('button', { name: 'Read Example a' })).toHaveTextContent('Complete edited body');
  });

  it('ignores an older hydration response after another record is edited', async () => {
    const full = deferred();
    api.getBrainMemory.mockReturnValueOnce(full.promise);
    await mount([memory('a', { content: 'Preview only', contentTruncated: true }), memory('b')]);
    edit('Example a');
    edit('Example b');
    fireEvent.change(screen.getByRole('textbox', { name: 'What happened' }), { target: { value: 'New body b' } });
    await act(async () => { full.resolve(memory('a')); });
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Example b');
    expect(screen.getByRole('textbox', { name: 'What happened' })).toHaveValue('New body b');
    api.updateBrainMemory.mockResolvedValue(memory('b', { content: 'New body b' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true })); });
    expect(api.updateBrainMemory).toHaveBeenCalledWith('b', expect.objectContaining({ content: 'New body b' }), { silent: true });
  });

  it('keeps a newer editing session when an older save finishes', async () => {
    const saved = deferred();
    api.updateBrainMemory.mockReturnValueOnce(saved.promise).mockResolvedValueOnce(memory('b', { content: 'New body b' }));
    await mount([memory('a'), memory('b')]);
    edit('Example a');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    edit('Example b');
    fireEvent.change(screen.getByRole('textbox', { name: 'What happened' }), { target: { value: 'New body b' } });
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await act(async () => { saved.resolve(memory('a')); });
    expect(screen.getByRole('textbox', { name: 'What happened' })).toHaveValue('New body b');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true })); });
    expect(api.updateBrainMemory).toHaveBeenLastCalledWith('b', expect.objectContaining({ content: 'New body b' }), { silent: true });
  });

  it('does not restore a canceled hydration after reopening the same record', async () => {
    const older = deferred();
    const newer = deferred();
    api.getBrainMemory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await mount([memory('a', { contentTruncated: true })]);
    edit('Example a');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    edit('Example a');
    await act(async () => { newer.resolve(memory('a', { content: 'Current body' })); });
    fireEvent.change(screen.getByRole('textbox', { name: 'What happened' }), { target: { value: 'New unsaved body' } });
    await act(async () => { older.resolve(memory('a')); });
    expect(screen.getByRole('textbox', { name: 'What happened' })).toHaveValue('New unsaved body');
  });

  it('disables the submitted form while saving and preserves it after failure', async () => {
    const saved = deferred();
    api.updateBrainMemory.mockReturnValueOnce(saved.promise);
    await mount([memory('a')]);
    edit('Example a');
    fireEvent.change(screen.getByRole('textbox', { name: 'What happened' }), { target: { value: 'Unsaved body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(screen.getByRole('textbox', { name: 'What happened' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(api.updateBrainMemory).toHaveBeenCalledTimes(1);
    await act(async () => { saved.reject(new Error('Write failed')); });
    expect(screen.getByRole('textbox', { name: 'What happened' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'What happened' })).toHaveValue('Unsaved body');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });

  it('invalidates a hydration across a type change even when record IDs coincide', async () => {
    const full = deferred();
    api.getBrainMemory.mockReturnValueOnce(full.promise);
    api.getBrainPeople.mockResolvedValue([{ id: 'a', name: 'Example person', context: 'Person context' }]);
    await mount([memory('a', { contentTruncated: true })]);
    edit('Example a');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'People' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    await act(async () => { full.resolve(memory('a')); });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Example person');
    expect(screen.getByRole('textbox', { name: /Context/ })).toHaveValue('Person context');
  });
});
