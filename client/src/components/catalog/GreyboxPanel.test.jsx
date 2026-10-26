import { forwardRef, useImperativeHandle } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GreyboxPanel from './GreyboxPanel';
import { captureCatalogGreyboxShot, draftCatalogGreybox, saveCatalogGreybox } from '../../services/apiCatalog';
import { blankGreybox } from '../../lib/greybox';

vi.mock('../../services/apiCatalog', () => ({
  captureCatalogGreyboxShot: vi.fn(), draftCatalogGreybox: vi.fn(), saveCatalogGreybox: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../musicVideo/MusicVideoLlmPicker', () => ({
  default: ({ onChange }) => <button type="button" onClick={() => onChange({ providerId: 'p1', model: 'm1', effort: 'high' })}>pick llm</button>,
}));
const view = vi.hoisted(() => ({ position: [1, 2, 3], target: [0, 1, 0] }));
vi.mock('./GreyboxViewer', () => ({
  default: forwardRef(function Viewer(_props, ref) {
    useImperativeHandle(ref, () => ({ getView: () => view, setView: vi.fn(), capture: () => 'data:image/png;base64,QUJD' }));
    return <div data-testid="viewer" />;
  }),
}));

const scene = blankGreybox();
const record = { id: 'plc-1', type: 'place', name: 'Rink', payload: { description: 'Roller rink', greybox: scene } };
const onSaved = vi.fn();
const onCaptured = vi.fn();
const show = (props = {}) => render(
  <MemoryRouter initialEntries={['/environments/plc-1/greybox?shot=wide']}>
    <GreyboxPanel record={record} media={[]} onSaved={onSaved} onCaptured={onCaptured} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.resetAllMocks();
  captureCatalogGreyboxShot.mockResolvedValue({ mediaKey: 'cap.png' });
  saveCatalogGreybox.mockImplementation(async (id, greybox) => ({ id, payload: { greybox } }));
});

describe('GreyboxPanel', () => {
  it('previews an AI draft with the exact prompt and stores it only when applied', async () => {
    const drafted = { ...scene, parts: [...scene.parts, { id: 'booth', type: 'box', size: [3, 2, 2], position: [0, 1, -6], rotationDegrees: [0, 0, 0] }] };
    draftCatalogGreybox.mockResolvedValue({ greybox: drafted, edited: true, sentPrompt: 'FULL PROMPT', promptAdditions: [{ id: 'greybox-contract', label: 'Greybox scene contract', text: 'rules' }], providerId: 'p1', model: 'm1' });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'pick llm' }));
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'add a DJ booth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft the edit' }));
    expect(await screen.findByText(/Draft preview, not saved yet/)).toBeInTheDocument();
    expect(draftCatalogGreybox).toHaveBeenCalledWith('plc-1', expect.objectContaining({ instruction: 'add a DJ booth', providerId: 'p1', model: 'm1', effort: 'high', useCurrent: true }), { silent: true });
    expect(screen.getByRole('button', { name: /Greybox scene contract/ })).toBeInTheDocument();
    expect(saveCatalogGreybox).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply draft' }));
    await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', drafted, { source: 'refine', silent: true }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('saves the camera onto the selected shot, then uploads the capture as base64', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Capture reference image/ }));
    await waitFor(() => expect(captureCatalogGreyboxShot).toHaveBeenCalledWith('plc-1', 'wide', 'QUJD', { silent: true }));
    const saved = saveCatalogGreybox.mock.calls[0][1];
    expect(saved.shots[0]).toMatchObject({ id: 'wide', position: [1, 2, 3], target: [0, 1, 0] });
    expect(saveCatalogGreybox.mock.invocationCallOrder[0]).toBeLessThan(captureCatalogGreyboxShot.mock.invocationCallOrder[0]);
    expect(onCaptured).toHaveBeenCalled();
  });

  it('offers a blank room when the place has no greybox', async () => {
    show({ record: { ...record, payload: { description: 'Roller rink' } } });
    fireEvent.click(await screen.findByRole('button', { name: /Start from a blank room/ }));
    await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', expect.objectContaining({ source: 'spec' }), expect.anything()));
  });
});
