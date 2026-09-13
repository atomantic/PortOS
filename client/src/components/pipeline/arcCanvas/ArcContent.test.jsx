import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const updatePipelineSeries = vi.fn();
vi.mock('../../../services/api', () => ({
  updatePipelineSeries: (...args) => updatePipelineSeries(...args),
}));

const toastMock = vi.hoisted(() => {
  const fn = vi.fn();
  fn.success = vi.fn(); fn.error = vi.fn(); fn.loading = vi.fn(); fn.warning = vi.fn(); fn.dismiss = vi.fn();
  return fn;
});
vi.mock('../../ui/Toast', () => ({ default: toastMock, toast: toastMock, Toaster: () => null }));

// The shape picker / ticking-clock editor / theme chips pull their own graphs;
// this suite is about the DRAFT COMMIT contract, so stub them inert.
vi.mock('../StoryShapes', () => ({
  ArcShapePicker: () => <div data-testid="shape-picker" />,
  ArcShapeSparkline: () => <svg />,
  getStoryShape: () => null,
}));
vi.mock('./TickingClockEditor.jsx', () => ({ default: () => <div /> }));
vi.mock('./TickingClockCard.jsx', () => ({ default: () => <div /> }));
vi.mock('./ThemeChips.jsx', () => ({ default: () => <div /> }));
vi.mock('./FieldLockToggle.jsx', () => ({ default: () => <button type="button">lock</button> }));

import ArcContent from './ArcContent.jsx';

const SERIES = { id: 's1', arc: { logline: 'Old logline', summary: 'S', protagonistArc: 'P', themes: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  updatePipelineSeries.mockResolvedValue({ ...SERIES, arc: { ...SERIES.arc, logline: 'New logline' } });
});

// Grab the committer ArcContent hands up, so the tests can invoke it the way a
// host's flushPending() does before locking / generating.
const renderWithRegistry = (props = {}) => {
  const registered = { fn: null };
  const onRegisterDraftFlush = vi.fn((fn) => { registered.fn = fn; });
  const onSeriesUpdate = vi.fn();
  render(<ArcContent series={SERIES} onSeriesUpdate={onSeriesUpdate} onRegisterDraftFlush={onRegisterDraftFlush} {...props} />);
  return { registered, onSeriesUpdate, onRegisterDraftFlush };
};

const openEditorAndType = (text) => {
  fireEvent.click(screen.getByText('Edit arc'));
  fireEvent.change(screen.getByPlaceholderText('One-sentence whole-arc pitch'), { target: { value: text } });
};

describe('ArcContent draft flush registration', () => {
  it('commits the OPEN editor draft and reports the save', async () => {
    const { registered, onSeriesUpdate } = renderWithRegistry();
    openEditorAndType('New logline');

    let did;
    await act(async () => { did = await registered.fn(); });

    expect(did).toBe(true);
    expect(updatePipelineSeries).toHaveBeenCalledWith('s1', { arc: expect.objectContaining({ logline: 'New logline' }) }, { silent: true });
    expect(onSeriesUpdate).toHaveBeenCalled();
    // Committed → the editor closes, same as the explicit Save button.
    expect(screen.getByText('Edit arc')).toBeTruthy();
  });

  it('is a no-op when the editor is closed', async () => {
    const { registered } = renderWithRegistry();
    let did;
    await act(async () => { did = await registered.fn(); });
    expect(did).toBe(false);
    expect(updatePipelineSeries).not.toHaveBeenCalled();
  });

  it('is a no-op when the editor is open but untouched', async () => {
    const { registered } = renderWithRegistry();
    fireEvent.click(screen.getByText('Edit arc'));
    let did;
    await act(async () => { did = await registered.fn(); });
    expect(did).toBe(false);
    expect(updatePipelineSeries).not.toHaveBeenCalled();
  });

  it('reports failed save (and keeps the editor open) when the PATCH rejects', async () => {
    updatePipelineSeries.mockRejectedValue(new Error('boom'));
    const { registered } = renderWithRegistry();
    openEditorAndType('New logline');

    let did;
    await act(async () => { did = await registered.fn(); });
    expect(did).toBe(null);
    expect(toastMock.error).toHaveBeenCalled();
    // Editor stays open so the unsaved text is still on screen and recoverable.
    expect(screen.getByPlaceholderText('One-sentence whole-arc pitch')).toBeTruthy();
  });

  it('unregisters on unmount so a torn-down editor can never be committed', () => {
    const registered = { fn: undefined };
    const onRegisterDraftFlush = vi.fn((fn) => { registered.fn = fn; });
    const { unmount } = render(
      <ArcContent series={SERIES} onSeriesUpdate={vi.fn()} onRegisterDraftFlush={onRegisterDraftFlush} />,
    );
    expect(registered.fn).toBeTypeOf('function');
    unmount();
    expect(registered.fn).toBe(null);
  });
});


describe('Series design authoring', () => {
  it('authors a brief before an arc exists and flushes it', async () => {
    const { registered } = renderWithRegistry({ series: { id: 'new', arc: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Add series design' }));
    fireEvent.change(screen.getByLabelText('Story intent'), { target: { value: 'finite' } });
    fireEvent.change(screen.getByLabelText('Ending condition'), { target: { value: 'Solve the central case.' } });
    expect(updatePipelineSeries).not.toHaveBeenCalled();
    await act(async () => { await registered.fn(); });
    expect(updatePipelineSeries).toHaveBeenCalledWith('new', { arc: { seriesDesign: { mode: 'finite', endingCondition: 'Solve the central case.' } } }, { silent: true });
  });

  it('keeps a failed brief draft available', async () => {
    updatePipelineSeries.mockRejectedValue(new Error('offline'));
    const { registered } = renderWithRegistry();
    fireEvent.click(screen.getByText('Edit arc'));
    fireEvent.change(screen.getByLabelText('Story intent'), { target: { value: 'renewable' } });
    await act(async () => { expect(await registered.fn()).toBe(null); });
    expect(screen.getByLabelText('Story intent').value).toBe('renewable');
    fireEvent.click(screen.getByText('Cancel'));
  });

  it('clears a saved brief explicitly', async () => {
    const { registered } = renderWithRegistry({ series: { ...SERIES, arc: { ...SERIES.arc, seriesDesign: { mode: 'renewable' } } } });
    fireEvent.click(screen.getByText('Edit arc'));
    const selectors = screen.getAllByLabelText('Story intent');
    fireEvent.change(selectors[0], { target: { value: '' } });
    await act(async () => { await registered.fn(); });
    expect(updatePipelineSeries.mock.calls[0][1].arc.seriesDesign).toBe(null);
  });

  it('disables authoring when the arc is locked', () => {
    renderWithRegistry({ series: { ...SERIES, locked: { arc: true } } });
    expect(screen.getByText('Edit arc').disabled).toBe(true);
  });
});
