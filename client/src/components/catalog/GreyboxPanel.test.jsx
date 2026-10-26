import { forwardRef, useImperativeHandle, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GreyboxPanel from './GreyboxPanel';
import { captureCatalogGreyboxShot, draftCatalogGreybox, previewCatalogGreyboxPrompt, saveCatalogGreybox } from '../../services/apiCatalog';
import { greyboxSceneSchema } from '../../../../server/lib/greyboxScene';
import toast from '../ui/Toast';
import { blankGreybox } from '../../lib/greybox';
import { GREYBOX_STARTERS } from '../../lib/greyboxStarters';

vi.mock('../../services/apiCatalog', () => ({
  captureCatalogGreyboxShot: vi.fn(), draftCatalogGreybox: vi.fn(), previewCatalogGreyboxPrompt: vi.fn(), saveCatalogGreybox: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../musicVideo/MusicVideoLlmPicker', () => ({
  default: ({ onChange }) => <button type="button" onClick={() => onChange({ providerId: 'p1', model: 'm1', effort: 'high' })}>pick llm</button>,
}));
const view = vi.hoisted(() => ({ position: [1, 2, 3], target: [0, 1, 0] }));
vi.mock('./GreyboxViewer', () => ({
  default: forwardRef(function Viewer(props, ref) {
    useImperativeHandle(ref, () => ({ getView: () => view, setView: vi.fn(), capture: () => 'data:image/png;base64,QUJD' }));
    return <div data-testid="viewer" data-selected={props.selected}>
      <button type="button" disabled={!props.onMoveAnchor} onClick={() => props.onMoveAnchor(props.scene.anchors[0]?.id, [1.2, 0, -2.3])}>Move anchor</button>
    </div>;
  }),
}));

const scene = blankGreybox();
const record = { id: 'plc-1', type: 'place', name: 'Rink', payload: { description: 'Roller rink', greybox: scene } };
const onSaved = vi.fn();
const onCaptured = vi.fn();
function SavedPanel(props) {
  const [current, setCurrent] = useState(props.record || record);
  return <GreyboxPanel record={current} media={[]} onCaptured={onCaptured} {...props} onSaved={(next) => { setCurrent(next); onSaved(next); }} />;
}
const show = (props = {}) => render(
  <MemoryRouter initialEntries={['/environments/plc-1/greybox?shot=wide']}>
    <SavedPanel {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.resetAllMocks();
  captureCatalogGreyboxShot.mockResolvedValue({ mediaKey: 'cap.png' });
  previewCatalogGreyboxPrompt.mockResolvedValue({ sentPrompt: 'PREVIEW PROMPT', promptAdditions: [{ id: 'greybox-place', label: 'Place', text: 'Rink' }] });
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

  it('shows the server-composed prompt before any provider call, and removes the greybox after confirming', async () => {
    show();
    fireEvent.change(await screen.findByLabelText('What should change?'), { target: { value: 'add a booth' } });
    expect(await screen.findByRole('button', { name: /Place/ })).toBeInTheDocument();
    expect(previewCatalogGreyboxPrompt).toHaveBeenCalledWith('plc-1', expect.objectContaining({ instruction: 'add a booth', useCurrent: true }), { silent: true });
    expect(draftCatalogGreybox).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove greybox' }));
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', null, { source: undefined, silent: true }));
  });

  it('offers a blank room when the place has no greybox', async () => {
    show({ record: { ...record, payload: { description: 'Roller rink' } } });
    fireEvent.click(await screen.findByRole('button', { name: /Start from a blank room/ }));
    await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', expect.objectContaining({ source: 'spec' }), expect.anything()));
  });

  it('starts the rink in one click, blocks overlapping starts, and displays its saved shots', async () => {
    let finishSave;
    saveCatalogGreybox.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    const busyChanged = vi.fn();
    function SavedPlace() {
      const [place, setPlace] = useState({ ...record, payload: {} });
      return <GreyboxPanel record={place} media={[]} onSaved={setPlace} onBusyChange={busyChanged} />;
    }
    render(<MemoryRouter initialEntries={['/?shot=stale']}><SavedPlace /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Roller rink/ }));
    expect(screen.getByRole('button', { name: /Outdoor plaza/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Start from a blank room/ })).toBeDisabled();
    const starter = GREYBOX_STARTERS[0].scene;
    expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', starter, { source: undefined, silent: true });
    finishSave({ ...record, payload: { greybox: starter } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Rink wide/, pressed: true })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Rail level/ })).toBeInTheDocument();
    expect(screen.getByTestId('viewer')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Start from a starter' })).not.toBeInTheDocument();
    expect(busyChanged.mock.calls).toEqual([[true], [false]]);
    expect(draftCatalogGreybox).not.toHaveBeenCalled();
  });

  it('keeps the starter picker available after a rejected save', async () => {
    saveCatalogGreybox.mockRejectedValue(new Error('Scene could not be saved'));
    show({ record: { ...record, payload: {} } });
    fireEvent.click(screen.getByRole('button', { name: /Outdoor plaza/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Scene could not be saved'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Outdoor plaza/ })).toBeEnabled();
  });

  it.each([{ readOnly: true }, { disabled: true }, { record: { ...record, payload: { locked: true } } }])(
    'does not start scenes when the place cannot be changed: %j', (props) => {
      show({ record: { ...record, payload: {} }, ...props });
      const start = screen.getByRole('button', { name: /Plain room/ });
      expect(start).toBeDisabled();
      fireEvent.click(start);
      expect(saveCatalogGreybox).not.toHaveBeenCalled();
    },
  );
  it('adds, edits, saves and removes layout rows and shot figures without AI, using returned server state', async () => {
    saveCatalogGreybox.mockImplementation(async (id, greybox) => ({ id, payload: { greybox: greyboxSceneSchema.parse(greybox) } }));
    show();
    await screen.findByTestId('viewer');
    for (const title of ['Parts (1)', 'Anchors (0)', 'Landmarks (0)']) expect(screen.getByText(title).closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Zones (0)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add zone' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Stage' } });
    fireEvent.click(screen.getByText('Parts (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '  Block  ' } });
    fireEvent.change(screen.getByLabelText('Position (m) X'), { target: { value: '3.5' } });
    fireEvent.change(screen.getByLabelText('Rotation (degrees) Y'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Size (m) Z'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'zone' } });
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-selected', 'parts:part');
    fireEvent.click(screen.getByText('Anchors (0)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add anchor' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Dancer' } });
    fireEvent.change(screen.getByLabelText('Facing (degrees)'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Height (m)'), { target: { value: '1.8' } });
    fireEvent.click(screen.getByText('Landmarks (0)'));
    fireEvent.click(screen.getByRole('button', { name: 'Add landmark' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Entrance' } });
    fireEvent.change(screen.getByLabelText('Position (m) Z'), { target: { value: '-5' } });
    fireEvent.click(screen.getByText('Figures in “Wide”'));
    fireEvent.click(screen.getByLabelText('Dancer'));
    fireEvent.change(screen.getByLabelText('Pose for Dancer'), { target: { value: 'Waving' } });
    expect(screen.queryByRole('button', { name: 'Capture reference image' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save layout edits' }));
    await screen.findByRole('button', { name: 'Block' });
    expect(saveCatalogGreybox).toHaveBeenCalledWith('plc-1', expect.objectContaining({
      parts: expect.arrayContaining([expect.objectContaining({ id: 'part', label: '  Block  ', position: [3.5, 0.5, 0], rotationDegrees: [0, 45, 0], size: [1, 1, 2], zone: 'zone' })]),
      anchors: [expect.objectContaining({ facingDegrees: 90, heightMeters: 1.8 })],
      landmarks: [expect.objectContaining({ position: [0, 0, -5] })],
      shots: [expect.objectContaining({ figures: [{ anchorId: 'anchor', pose: 'Waving' }] })],
    }), { source: undefined, silent: true });
    expect(draftCatalogGreybox).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove anchor Dancer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove zone Stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove landmark Entrance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove part Block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save layout edits' }));
    await waitFor(() => expect(saveCatalogGreybox).toHaveBeenCalledTimes(2));
    expect(saveCatalogGreybox.mock.calls[1][1]).toMatchObject({ anchors: [], landmarks: [], zones: [], shots: [{ figures: [] }] });
    expect(saveCatalogGreybox.mock.calls[1][1].parts).toEqual(scene.parts);
  });

  it('keeps invalid numeric input local, preserves a failed save for retry, and discards edits', async () => {
    show();
    fireEvent.click(await screen.findByText('Parts (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Floor' }));
    fireEvent.change(screen.getByLabelText('Size (m) X'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save layout edits' })).toBeDisabled();
    expect(within(screen.getByLabelText('Layout errors')).getByText(/Part size/)).toBeInTheDocument();
    expect(saveCatalogGreybox).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Size (m) X'), { target: { value: '25' } });
    saveCatalogGreybox.mockRejectedValueOnce(new Error('Save failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Save layout edits' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed'));
    expect(screen.getByLabelText('Size (m) X')).toHaveValue(25);
    fireEvent.click(screen.getByRole('button', { name: 'Discard layout edits' }));
    expect(screen.getByLabelText('Size (m) X')).toHaveValue(20);
  });

  it('edits figure inclusion and saves a dragged anchor while gating every manual control during the write', async () => {
    const anchor = { id: 'performer', label: 'Performer', kind: 'figure', position: [0, 0, 0], facingDegrees: 0, heightMeters: 1.7 };
    let resolveSave;
    saveCatalogGreybox.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    show({ record: { ...record, payload: { greybox: { ...scene, anchors: [anchor] } } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Move anchor' }));
    fireEvent.click(screen.getByText('Figures in “Wide”'));
    fireEvent.click(screen.getByLabelText('Performer'));
    fireEvent.change(screen.getByLabelText('Pose for Performer'), { target: { value: 'Seated' } });
    fireEvent.click(screen.getByLabelText('Performer'));
    expect(screen.queryByLabelText('Pose for Performer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save layout edits' }));
    expect(screen.getByRole('button', { name: 'Add anchor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move anchor' })).toBeDisabled();
    const savedScene = saveCatalogGreybox.mock.calls[0][1];
    expect(savedScene.anchors[0].position).toEqual([1.2, 0, -2.3]);
    expect(savedScene.shots[0].figures).toEqual([]);
    await act(async () => { resolveSave({ ...record, payload: { greybox: savedScene } }); });
    expect(screen.queryByRole('button', { name: 'Save layout edits' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture reference image' })).toBeEnabled();
  });

  it.each([{ readOnly: true }, { disabled: true }, { record: { ...record, payload: { ...record.payload, locked: true } } }])('preserves manual editing gates: %j', async (props) => {
    show(props);
    expect(await screen.findByRole('button', { name: 'Move anchor' })).toBeDisabled();
    const add = screen.queryByRole('button', { name: 'Add anchor' });
    if (add) expect(add).toBeDisabled();
    expect(saveCatalogGreybox).not.toHaveBeenCalled();
  });

});
