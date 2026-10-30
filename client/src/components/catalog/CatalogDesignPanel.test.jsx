import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
vi.mock('../../services/apiCatalog', () => ({
  renderCatalogDesign: vi.fn(), spreadCatalogDesign: vi.fn(), updateCatalogIngredientMediaLibrary: vi.fn(), getCatalogIngredientDetails: vi.fn(),
}));
vi.mock('../../hooks/useModelInputPreview', () => ({ useModelInputPreview: () => ({ preview: { sentPrompt: 'example' }, error: null }) }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], selectedProviderId: 'example-api', availableModels: [], loading: false,
  setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector', () => ({ default: () => null }));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: ({ label, jobId, onStatus }) => <div>{label} rendering
  <button type="button" onClick={() => onStatus('failed', 'Runtime is down')}>fail {jobId}</button>
  <button type="button" onClick={() => onStatus('canceled')}>cancel {jobId}</button>
  <button type="button" onClick={() => onStatus('failed')}>blank {jobId}</button></div> }));
vi.mock('../IngredientPicker', () => ({ default: () => null }));
import CatalogDesignPanel from './CatalogDesignPanel';
import { renderCatalogDesign, updateCatalogIngredientMediaLibrary } from '../../services/apiCatalog';

const take = (file, role, extra = {}) => ({ mediaKey: file, kind: 'reference', role, createdAt: '2026-10-30T00:00:00Z',
  library: { likeness: false, review: { status: 'unreviewed', feedback: `Line for ${file}` }, ...extra } });
const media = [
  { mediaKey: 'old-face.png', kind: 'portrait', library: { guide: true } },
  { mediaKey: 'old-child.png', kind: 'reference', library: { guide: true, variant: { formId: 'form-child01' } } },
  take('second.png', 'design:r1:1'), take('first.png', 'design:r1:0'),
];
let location;
function Where() { location = useLocation(); return null; }
const mount = (props = {}) => render(<MemoryRouter initialEntries={['/casting/cast/design']}>
  <CatalogDesignPanel ingredientId="cast" name="Example performer" forms={[{ id: 'form-child01', label: 'Child', age: '7' }]}
    media={media} onChanged={vi.fn()} onSetPortrait={vi.fn()} {...props} />
  <Where />
</MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

describe('Casting design rounds', () => {
  it('shows a round in take order and keeps the pick in the URL', () => {
    mount();
    const lines = screen.getAllByText(/^Line for/).map((el) => el.textContent);
    expect(lines).toEqual(['Line for first.png', 'Line for second.png']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick' })[1]);
    expect(new URLSearchParams(location.search).get('take')).toBe('second.png');
    expect(screen.getByText('Picked take')).toBeTruthy();
  });

  // The old face kept winning because its guides stayed on: the anchor
  // becomes the canonical age's only guide and its primary image.
  it('makes a picked take the anchor, turning off the old guides for that age only', async () => {
    const onSetPortrait = vi.fn();
    updateCatalogIngredientMediaLibrary.mockResolvedValue({});
    mount({ onSetPortrait });
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Make anchor' }));
    await waitFor(() => expect(onSetPortrait).toHaveBeenCalledWith('first.png'));
    expect(updateCatalogIngredientMediaLibrary.mock.calls.map(([, body]) => body)).toEqual([
      { mediaKey: 'old-face.png', kind: 'portrait', guide: false },
      { mediaKey: 'first.png', kind: 'reference', likeness: true, guide: true },
    ]);
  });

  it('queues a feature grid from the picked take and shows its pending takes', async () => {
    renderCatalogDesign.mockResolvedValue({ roundId: 'r2', jobs: [{ jobId: 'job-1', line: 'Make the nose far smaller.' }] });
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick' })[0]);
    fireEvent.click(screen.getByRole('tab', { name: 'Vary a feature' }));
    fireEvent.change(screen.getByLabelText('Feature'), { target: { value: 'chin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Render 8 takes' }));
    await waitFor(() => expect(renderCatalogDesign).toHaveBeenCalledWith('cast',
      { mode: 'feature', baseImageFile: 'first.png', feature: 'chin' }, { silent: true }));
    expect(await screen.findByText('Take rendering')).toBeTruthy();
    expect(within(screen.getByLabelText('Design this cast member')).getByText('Make the nose far smaller.')).toBeTruthy();
  });

  it('records the takes that landed when a later take is refused and keeps the composer', async () => {
    renderCatalogDesign.mockRejectedValue(Object.assign(new Error('Queued 1 of 8 takes — queue is full'),
      { context: { roundId: 'r3', jobs: [{ jobId: 'job-9', line: 'Make the chin far smaller.' }] } }));
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick' })[0]);
    fireEvent.click(screen.getByRole('tab', { name: 'Vary a feature' }));
    fireEvent.click(screen.getByRole('button', { name: 'Render 8 takes' }));
    expect(await screen.findByText('Queued 1 of 8 takes — queue is full')).toBeTruthy();
    expect(await screen.findByText('Take rendering')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Render 8 takes' })).toBeTruthy();
  });

  describe.each([
    ['fail', 'Runtime is down'],
    ['cancel', 'This take was canceled. Render it again if you still want it.'],
    ['blank', 'This take failed. Render it again if you still want it.'],
  ])('a pending take that ends via %s', (action, message) => {
    it('shows why on the panel alert and forgets the job', async () => {
      sessionStorage.setItem('catalog_design_pending_cast', JSON.stringify([{ jobId: 'job-7', roundId: 'r5', line: 'x', startedAt: 1 }]));
      mount();
      fireEvent.click(await screen.findByRole('button', { name: `${action} job-7` }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      await waitFor(() => expect(screen.queryByText('Take rendering')).toBeNull());
      expect(sessionStorage.getItem('catalog_design_pending_cast')).toBeNull();
    });
  });
});
