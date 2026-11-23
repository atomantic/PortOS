/**
 * One Blender model's page through the real hook, tabs and film Files/Jobs tabs:
 * only the API module, the socket and the WebGL viewer are doubled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const socketHandlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({ default: {
  on: (event, fn) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event).add(fn); },
  off: (event, fn) => socketHandlers.get(event)?.delete(fn),
} }));
vi.mock('../components/media/GlbViewer', () => ({
  default: ({ src, downloadHref, isolateNode, pose, highlightNodes }) => <div data-testid="glb-viewer" data-download={downloadHref || ''} data-part={isolateNode || ''}
    data-pose={pose ? JSON.stringify(pose) : ''} data-highlight={(highlightNodes || []).join(',')}>{src}</div>,
}));
vi.mock('../lib/clipboard.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../services/apiBlenderModels.js', () => ({
  getBlenderModel: vi.fn(), createBlenderModel: vi.fn(), updateBlenderModel: vi.fn(), deleteBlenderModel: vi.fn(), scaffoldBlenderModel: vi.fn(),
  listBlenderModelFiles: vi.fn(), readBlenderModelFile: vi.fn(), writeBlenderModelFile: vi.fn(), deleteBlenderModelFile: vi.fn(),
  buildBlenderModel: vi.fn(), cancelBlenderModelBuild: vi.fn(), openBlenderModelBuild: vi.fn(), publishBlenderModelBuild: vi.fn(),
  getBlenderModelBuildReport: vi.fn(), getBlenderModelBuildLog: vi.fn(),
  updateBlenderModelReferenceSource: vi.fn(), addBlenderModelCloseup: vi.fn(), removeBlenderModelCloseup: vi.fn(), previewBlenderModelReference: vi.fn(),
  renderBlenderModelReference: vi.fn(), attachBlenderModelReferenceImage: vi.fn(), reviewBlenderModelReference: vi.fn(), createBlenderModelPartsBrief: vi.fn(),
  renderBlenderModelReview: vi.fn(), cancelBlenderModelReview: vi.fn(), getBlenderModelReviewLog: vi.fn(),
  addBlenderModelCamera: vi.fn(), updateBlenderModelCamera: vi.fn(), removeBlenderModelCamera: vi.fn(),
  addBlenderModelDifference: vi.fn(), updateBlenderModelDifference: vi.fn(), removeBlenderModelDifference: vi.fn(),
  blenderModelReviewFileUrl: (_id, buildId, name) => `/review/${buildId}/${name}`,
  blenderModelBuildFileUrl: (id, buildId, name) => `/api/blender-models/${id}/builds/${buildId}/files/${name}`,
  blenderModelAssetUrl: (id) => `/api/blender-models/${id}/asset`,
}));
vi.mock('../services/apiMoodBoard.js', () => ({ listMoodBoardNames: vi.fn(async () => []), getMoodBoard: vi.fn() }));
import * as api from '../services/apiBlenderModels.js';
import { copyToClipboard } from '../lib/clipboard.js';
import BlenderModelDetail from './BlenderModelDetail';

const ID = 'bmodel-1';
const A = 'build-20260101T000000Z-0000000a';
const B = 'build-20260102T000000Z-0000000b';
const build = (id, extra = {}) => ({
  id, status: 'complete', quality: 'draft', srcHash: 'h1', publishable: true, counts: { error: 0, warning: 0, note: 1 }, error: null,
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z', ...extra,
});
const modelState = (extra = {}) => ({
  id: ID, name: 'Example lamp', description: 'A folding desk lamp', status: 'draft', publishedBuildId: null, describe: null, builds: [],
  workspace: { path: '/srv/example/blender-models/bmodel-1', exists: true, hasModel: true, files: 1, srcHash: 'h1', srcChanged: null },
  tool: { ready: true, reason: null, executionMode: 'trusted-local', version: '5.3.0' }, jobs: [], ...extra,
});
const reportOf = (buildId, findings = []) => ({
  buildId, describe: { title: 'Desk lamp', parts: [{ id: 'base', label: 'Weighted base' }, { id: 'shade', label: 'Shade', parent: 'base' }, { id: 'bulb', label: 'Bulb' }] },
  checks: {
    parts: { declared: 3, built: 2, missing: ['bulb'], undeclared: [] }, triangles: { total: 2180, budget: 2000 },
    bounds: { declared: { x: 0.22, y: 0.22, z: 0.52 }, actual: { x: 0.22, y: 0.22, z: 0.8 } }, glbBytes: 10,
  },
  findings,
});
const changed = async () => act(async () => { for (const fn of socketHandlers.get('blender-model:changed') || []) fn({ id: ID }); });

function Probe() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}{location.search}</output>;
}
const renderAt = (entry = `/3d/blender/${ID}`) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/3d/blender/:id/:tab?" element={<BlenderModelDetail />} /><Route path="*" element={null} /></Routes>
    <Probe />
  </MemoryRouter>,
);
const serve = (state) => api.getBlenderModel.mockResolvedValue(state);

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  serve(modelState());
  api.cancelBlenderModelBuild.mockResolvedValue({ ok: true });
  api.getBlenderModelBuildReport.mockImplementation(async (_id, buildId) => reportOf(buildId));
  api.listBlenderModelFiles.mockResolvedValue({ files: [{ path: 'model.py', bytes: 10, mtime: 1, text: true }] });
  api.readBlenderModelFile.mockResolvedValue({ content: 'SIDES = 8\n' });
});

describe('BlenderModelDetail', () => {
  it('starts an empty model from the starter script', async () => {
    const user = userEvent.setup();
    serve(modelState({ workspace: { ...modelState().workspace, hasModel: false, files: 0 } }));
    api.scaffoldBlenderModel.mockResolvedValue(modelState());
    renderAt();
    expect(await screen.findByRole('button', { name: 'Build draft' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create starter script' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Build draft' })).toBeEnabled());
  });

  it('names why Blender is not ready, links to Blender execution and holds builds back', async () => {
    serve(modelState({ tool: { ready: false, reason: 'Set Blender to Trusted local.', executionMode: 'contained', version: null } }));
    renderAt();
    expect(await screen.findByText(/Set Blender to Trusted local/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Blender execution' })).toHaveAttribute('href', '/code-animation/production#blender-execution');
    expect(screen.getByRole('button', { name: 'Build draft' })).toBeDisabled();
  });

  it('builds, follows the build by socket event, reports findings and publishes', async () => {
    const user = userEvent.setup();
    api.buildBlenderModel.mockResolvedValue({ job: { id: 'bj-1' }, build: { id: A } });
    renderAt();
    const start = await screen.findByRole('button', { name: 'Build draft' });
    serve(modelState({ status: 'building', builds: [build(A, { status: 'running', counts: null, publishable: false, finishedAt: null })] }));
    await user.click(start);
    expect(api.buildBlenderModel).toHaveBeenCalledWith(ID, 'draft', { silent: true });
    await user.click(await screen.findByRole('button', { name: 'Cancel build' }));
    expect(api.cancelBlenderModelBuild).toHaveBeenCalledWith(ID, A, { silent: true });

    serve(modelState({ builds: [build(A)] }));
    await changed();
    expect(await screen.findByTestId('glb-viewer')).toHaveTextContent(`/builds/${A}/files/model.glb`);
    expect(await screen.findByText('Every check passed.')).toBeInTheDocument();
    api.publishBlenderModelBuild.mockResolvedValue(modelState({ status: 'published', publishedBuildId: A, builds: [build(A)] }));
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(api.publishBlenderModelBuild).toHaveBeenCalledWith(ID, A, { silent: true });
    await waitFor(() => expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-download', `/api/blender-models/${ID}/asset`));
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('refuses to publish a flagged build and groups its findings by severity', async () => {
    serve(modelState({ builds: [build(A, { publishable: false, counts: { error: 1, warning: 1, note: 0 } })] }));
    api.getBlenderModelBuildReport.mockResolvedValue(reportOf(A, [
      { severity: 'error', code: 'part-missing', message: 'A declared part has no mesh object', subjects: ['bulb'] },
      { severity: 'warning', code: 'scale-unapplied', message: 'An unapplied scale', subjects: ['shade'] },
    ]));
    renderAt();
    expect(within(await screen.findByRole('list', { name: 'Errors' })).getByText(/no mesh object/)).toHaveTextContent('bulb');
    expect(within(screen.getByRole('list', { name: 'Warnings' })).getByText(/unapplied scale/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByLabelText('Measurements')).toHaveTextContent('2,180 of 2,000');
    expect(screen.getByLabelText('Measurements')).toHaveTextContent('0.22 × 0.22 × 0.8 m');
    expect(screen.getByRole('button', { name: /Bulb/ })).toBeDisabled();
  });

  it('restores the selected build and part from the URL, and keeps them across tabs', async () => {
    const user = userEvent.setup();
    serve(modelState({ builds: [build(A), build(B)] }));
    renderAt(`/3d/blender/${ID}/model?build=${A}&part=shade`);
    const viewer = await screen.findByTestId('glb-viewer');
    expect(viewer).toHaveTextContent(A);
    await waitFor(() => expect(viewer).toHaveAttribute('data-part', 'shade'));
    await user.click(screen.getByRole('button', { name: /Weighted base/ }));
    expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-part', 'base');
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent(`/3d/blender/${ID}/settings?build=${A}&part=base`);
    await user.click(screen.getByRole('tab', { name: 'Model' }));
    await user.click(await screen.findByRole('button', { name: 'Whole model' }));
    expect(screen.getByTestId('glb-viewer')).toHaveAttribute('data-part', '');
  });

  describe('with moving parts', () => {
    const control = (id, label, extra = {}) => ({ id, label, type: 'hinge', partId: id, min: 0, max: 110, default: 0, default01: 0, dependsOn: [], ...extra });
    const motion = (sweep = {}) => ({
      controls: [control('lid', 'Lid'), control('clip', 'Clip', { type: 'slide', max: 0.1, dependsOn: [{ control: 'lid', atMost: 0.02 }] })],
      actions: [], sweep: { poses: 88, overlaps: [], unmeasured: [], clean: true, ...sweep },
    });
    const serveMotion = (value, findings = []) => {
      serve(modelState({ builds: [build(A)] }));
      const report = reportOf(A, findings);
      api.getBlenderModelBuildReport.mockResolvedValue({ ...report, checks: { ...report.checks, motion: value } });
    };
    const pose = () => JSON.parse(screen.getByTestId('glb-viewer').getAttribute('data-pose'));

    it('drives the GLB by the sliders and holds a control back until its dependency is met', async () => {
      const user = userEvent.setup();
      serveMotion(motion());
      renderAt();
      const lid = await screen.findByRole('slider', { name: 'Lid' });
      const clip = screen.getByRole('slider', { name: 'Clip' });
      expect(screen.getByText('88 poses checked; no parts pass through each other.')).toBeInTheDocument();
      fireEvent.change(clip, { target: { value: '0.5' } });
      expect(pose()).toEqual({ 'control:lid': 0, 'control:clip': 0.5 });
      // Opening the lid takes the clip back with it, and says why it cannot close.
      fireEvent.change(lid, { target: { value: '0.5' } });
      expect(pose()).toEqual({ 'control:lid': 0.5, 'control:clip': 0 });
      expect(lid).toHaveAttribute('aria-valuetext', '55°');
      expect(clip).toBeDisabled();
      expect(clip).toHaveAccessibleDescription('Needs Lid at most 0.02');
      await user.click(screen.getByRole('button', { name: 'Reset pose' }));
      expect(pose()).toEqual({ 'control:lid': 0, 'control:clip': 0 });
      expect(clip).toBeEnabled();
    });

    it('shows the pose of an overlap finding with its two parts highlighted', async () => {
      const user = userEvent.setup();
      serveMotion(motion({ clean: false, overlaps: [{ parts: ['base', 'shade'] }] }), [
        { severity: 'error', code: 'sweep-overlap', message: 'base and shade pass through each other', subjects: ['base', 'shade'], pose: { lid: 0.15, clip: 0 } },
        { severity: 'error', code: 'sweep-overlap', message: 'base and bulb pass through each other', subjects: ['base', 'bulb'], pose: { lid: 0.9, clip: 0 } },
      ]);
      renderAt(`/3d/blender/${ID}/model?part=shade`);
      await user.click(await screen.findByRole('button', { name: 'Show pose of base and shade' }));
      const viewer = screen.getByTestId('glb-viewer');
      expect(viewer).toHaveAttribute('data-highlight', 'base,shade');
      // A part shown alone would hide the other one.
      expect(viewer).toHaveAttribute('data-part', '');
      expect(pose()).toEqual({ 'control:lid': 0.15, 'control:clip': 0 });
      expect(screen.getByRole('slider', { name: 'Lid' })).toHaveValue('0.15');
      expect(screen.getByText('88 poses checked; 1 pair(s) of parts pass through each other.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Reset pose' }));
      expect(viewer).toHaveAttribute('data-highlight', '');
    });

    it('never calls a sweep that skipped poses clean', async () => {
      serveMotion(motion({ clean: false, poses: 4, unmeasured: [{ what: 'lid', planned: 21, measured: 4 }] }));
      renderAt();
      expect(await screen.findByText('4 poses checked; some poses were not checked.')).toBeInTheDocument();
    });
  });

  it('shows a failed build and its log while the published build stays on show', async () => {
    const user = userEvent.setup();
    serve(modelState({ status: 'published', publishedBuildId: A, builds: [build(A), build(B, { status: 'failed', publishable: false, counts: null, error: 'RuntimeError: example failure' })] }));
    api.getBlenderModelBuildLog.mockResolvedValue('Traceback example');
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('RuntimeError: example failure');
    expect(await screen.findByTestId('glb-viewer')).toHaveTextContent(A);
    await user.click(screen.getByRole('button', { name: 'Open build log' }));
    expect(await screen.findByLabelText('Build log')).toHaveTextContent('Traceback example');
    expect(api.getBlenderModelBuildLog).toHaveBeenCalledWith(ID, B, { silent: true });
  });

  it('lists a running job with its log and cancels it by build id', async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();
    serve(modelState({ status: 'building', builds: [build(A, { status: 'running', finishedAt: null, counts: null })], jobs: [{ id: 'bj-1', kind: 'build', status: 'running', buildId: A, quality: 'full', startedAt: now }] }));
    api.getBlenderModelBuildLog.mockResolvedValue('Building the lamp');
    renderAt(`/3d/blender/${ID}/builds`);
    const job = within(await screen.findByRole('list', { name: 'Jobs' })).getByRole('listitem');
    expect(job).toHaveTextContent('Build full');
    expect(job).toHaveTextContent('Building');
    await user.click(within(job).getByRole('button', { name: 'View log' }));
    expect(await screen.findByLabelText('Job log text')).toHaveTextContent('Building the lamp');
    await user.click(within(job).getByRole('button', { name: 'Cancel' }));
    expect(api.cancelBlenderModelBuild).toHaveBeenCalledWith(ID, A, { silent: true });
  });

  it('edits a source file; unsaved edits hold builds back until saved', async () => {
    const user = userEvent.setup();
    renderAt(`/3d/blender/${ID}/files?bfile=model.py`);
    const editor = await screen.findByLabelText('src/model.py');
    await waitFor(() => expect(editor).toHaveValue('SIDES = 8\n'));
    await user.type(editor, '# note');
    expect(screen.getByRole('button', { name: 'Build draft' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Model' }));
    expect(screen.getByText(/Save or discard your changes to src\/model.py/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open files' }));
    api.writeBlenderModelFile.mockResolvedValue({ path: 'model.py', bytes: 16 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.writeBlenderModelFile).toHaveBeenCalledWith(ID, 'model.py', 'SIDES = 8\n# note', { silent: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Build draft' })).toBeEnabled());
  });

  it('copies a brief naming the workspace, skill, readiness and open findings', async () => {
    const user = userEvent.setup();
    serve(modelState({ builds: [build(A, { publishable: false, counts: { error: 1, warning: 0, note: 0 } })] }));
    api.getBlenderModelBuildReport.mockResolvedValue(reportOf(A, [{ severity: 'error', code: 'part-missing', message: 'No mesh', subjects: ['bulb'] }]));
    renderAt();
    await screen.findByRole('list', { name: 'Errors' });
    await user.click(screen.getByRole('button', { name: 'Copy agent brief' }));
    const brief = copyToClipboard.mock.calls[0][0];
    for (const text of ['portos-blender-model', '/srv/example/blender-models/bmodel-1', 'A folding desk lamp', 'ready (5.3.0)', 'part-missing (bulb)', `/api/blender-models/${ID}`]) expect(brief).toContain(text);
  });

  it('saves only the changed details and deletes after a confirm', async () => {
    const user = userEvent.setup();
    renderAt(`/3d/blender/${ID}/settings`);
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Desk lamp');
    api.updateBlenderModel.mockResolvedValue(modelState({ name: 'Desk lamp' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateBlenderModel).toHaveBeenCalledWith(ID, { name: 'Desk lamp' }, { silent: true });
    expect(await screen.findByRole('heading', { name: 'Desk lamp' })).toBeInTheDocument();
    api.deleteBlenderModel.mockResolvedValue({ ok: true });
    await user.click(screen.getByRole('button', { name: 'Delete model' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByLabelText('Current location')).toHaveTextContent(/^\/3d$/));
  });

  it('says a deleted model is gone, and offers a retry when the read failed', async () => {
    api.getBlenderModel.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    const { unmount } = renderAt();
    expect(await screen.findByText('This model no longer exists.')).toBeInTheDocument();
    unmount();
    api.getBlenderModel.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    renderAt();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    serve(modelState());
    await userEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Example lamp' })).toBeInTheDocument();
  });

  describe('Compare', () => {
    const sheet = { id: 'overall', role: 'overall', words: '', approvedImageId: 'img-1', file: 'refs/overall.png', locked: false, outOfDate: false, images: [{ id: 'img-1', filename: 'sheet.png', status: 'approved' }] };
    const plate = { ...sheet, id: 'closeup-1', role: 'closeup', mechanism: 'Hinge', file: 'refs/hinge.png', images: [{ id: 'img-1', filename: 'hinge.png', status: 'approved' }] };
    const review = (buildId, extra = {}) => ({ buildId, renderedAt: '2026-01-01T00:00:00.000Z', sizeMeters: { x: 1, y: 1, z: 1 }, views: ['front', 'top', 'camera-1'], sheets: [], outOfDate: false, outdatedCameraIds: [], ...extra });
    const hinge = { id: 'camera-1', label: 'Hinge front', referenceId: 'closeup-1', crop: { x: 0.5, y: 0, width: 0.5, height: 1 }, view: null, orbit: { azimuth: 30, elevation: 10, distance: 0.4, lens: 85, partId: 'shade', target: [0, 0, 0.45] } };
    const compared = (extra = {}) => modelState({
      builds: [build(A), build(B)], references: [sheet, plate], cameras: [hinge], differences: [], reviews: [review(B), review(A, { outOfDate: true })], ...extra,
    });

    it('shows a reference beside two builds from the camera, surface and builds in the URL', async () => {
      const user = userEvent.setup();
      serve(compared());
      renderAt(`/3d/blender/${ID}/compare?cam=top&look=clay&vs=${A}`);
      const left = await screen.findByRole('figure', { name: /Build A/ });
      expect(within(left).getByRole('img')).toHaveAttribute('src', `/review/${B}/top-clay.png`);
      const right = screen.getByRole('figure', { name: /Build B/ });
      expect(within(right).getByRole('img')).toHaveAttribute('src', `/review/${A}/top-clay.png`);
      expect(within(right).getByText(/Out of date/)).toBeInTheDocument();
      expect(within(left).queryByText(/Out of date/)).toBeNull();
      expect(screen.getByRole('img', { name: 'Overall sheet reference' })).toHaveAttribute('src', '/data/images/sheet.png');

      await user.selectOptions(screen.getByLabelText('Reference'), 'closeup-1');
      await user.click(screen.getByRole('button', { name: 'Textured' }));
      await user.selectOptions(screen.getByLabelText('Build B'), '');
      expect(screen.getByLabelText('Current location')).toHaveTextContent(`/3d/blender/${ID}/compare?cam=top&ref=closeup-1`);
      expect(screen.queryByRole('figure', { name: /Build B/ })).toBeNull();

      // A saved camera brings its own reference and panel.
      await user.selectOptions(screen.getByLabelText('Camera'), 'camera-1');
      expect(screen.getByRole('img', { name: 'Hinge reference' })).toHaveAttribute('src', '/data/images/hinge.png');
      expect(screen.getByRole('img', { name: 'Hinge reference' }).style.left).toBe('-100%');
      expect(within(left).getByRole('img')).toHaveAttribute('src', `/review/${B}/camera-1-textured.png`);
      expect(screen.getByLabelText('Reference')).toBeDisabled();
    });

    it('says what is not rendered or no longer matches, and renders again', async () => {
      const user = userEvent.setup();
      serve(compared({ reviews: [review(B, { outdatedCameraIds: ['camera-1'] })] }));
      api.renderBlenderModelReview.mockResolvedValue({ job: { id: 'bj-1' } });
      renderAt(`/3d/blender/${ID}/compare?cam=camera-1&vs=${A}`);
      const left = await screen.findByRole('figure', { name: /Build A/ });
      expect(within(left).getByText(/camera changed since/)).toBeInTheDocument();
      expect(within(screen.getByRole('figure', { name: /Build B/ })).getByText('Not rendered yet.')).toBeInTheDocument();
      await user.click(within(left).getByRole('button', { name: 'Render again' }));
      expect(api.renderBlenderModelReview).toHaveBeenCalledWith(ID, B, { silent: true });
    });

    it('saves a new camera with its panel, and keeps the aim point when an orbit is edited', async () => {
      const user = userEvent.setup();
      serve(compared());
      renderAt(`/3d/blender/${ID}/compare`);
      await user.click(await screen.findByRole('button', { name: 'New camera' }));
      expect(screen.getByRole('button', { name: 'Save camera' })).toBeDisabled();
      await user.type(screen.getByLabelText('Camera name'), 'Sheet top');
      await user.selectOptions(screen.getByLabelText('Seen from'), 'top');
      await user.clear(screen.getByLabelText('Width'));
      await user.type(screen.getByLabelText('Width'), '150');
      expect(screen.getByRole('button', { name: 'Save camera' })).toBeDisabled();
      await user.clear(screen.getByLabelText('Width'));
      await user.type(screen.getByLabelText('Width'), '25');
      api.addBlenderModelCamera.mockResolvedValue(compared({ cameras: [hinge, { ...hinge, id: 'camera-2', label: 'Sheet top', view: 'top', orbit: null }] }));
      await user.click(screen.getByRole('button', { name: 'Save camera' }));
      expect(api.addBlenderModelCamera).toHaveBeenCalledWith(ID, { label: 'Sheet top', referenceId: 'overall', crop: { x: 0, y: 0, width: 0.25, height: 1 }, view: 'top' }, { silent: true });
      expect(await screen.findByLabelText('Current location')).toHaveTextContent('cam=camera-2');

      await user.selectOptions(screen.getByLabelText('Camera'), 'camera-1');
      await user.click(screen.getByRole('button', { name: 'Edit camera' }));
      await user.clear(screen.getByLabelText(/Azimuth/));
      await user.type(screen.getByLabelText(/Azimuth/), '45');
      api.updateBlenderModelCamera.mockResolvedValue(compared());
      await user.click(screen.getByRole('button', { name: 'Save camera' }));
      expect(api.updateBlenderModelCamera).toHaveBeenCalledWith(ID, 'camera-1', expect.objectContaining({ orbit: { ...hinge.orbit, azimuth: 45 } }), { silent: true });
    });

    it('records a difference, closes it on the shown build, and puts open ones in the brief', async () => {
      const user = userEvent.setup();
      serve(compared());
      renderAt(`/3d/blender/${ID}/compare?build=${A}`);
      await user.type(await screen.findByLabelText('Difference'), 'No hinge pin');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Shade' })).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Part (optional)'), 'shade');
      const open = { id: 'difference-1', text: 'No hinge pin', partId: 'shade', referenceId: 'overall', status: 'open', reason: '', closedBuildId: null };
      const accepted = { ...open, id: 'difference-2', text: 'Rounder base', status: 'accepted', reason: 'Easier to print', closedBuildId: A };
      api.addBlenderModelDifference.mockResolvedValue(compared({ differences: [accepted, open] }));
      await user.click(screen.getByRole('button', { name: 'Add' }));
      expect(api.addBlenderModelDifference).toHaveBeenCalledWith(ID, { text: 'No hinge pin', partId: 'shade', referenceId: 'overall' }, { silent: true });
      expect(await screen.findByRole('heading', { name: 'Differences · 1 open' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Copy agent brief' }));
      const brief = copyToClipboard.mock.lastCall[0];
      for (const text of ['difference-1: No hinge pin (part shade, src/refs/overall.png)', 'Rounder base: Easier to print', `renders/reviews/${B}/`, 'Hinge front: src/refs/hinge.png -> orbit azimuth 30']) expect(brief).toContain(text);
      expect(brief).not.toContain('difference-2:');

      api.updateBlenderModelDifference.mockResolvedValue(compared({ differences: [accepted] }));
      await user.click(screen.getByRole('button', { name: 'Accept…' }));
      await user.type(screen.getByLabelText('Why is this intended?'), 'Glued');
      await user.click(screen.getByRole('button', { name: 'Accept' }));
      expect(api.updateBlenderModelDifference).toHaveBeenLastCalledWith(ID, 'difference-1', { status: 'accepted', reason: 'Glued', buildId: A }, { silent: true });
      await user.click(await screen.findByRole('button', { name: 'Reopen' }));
      expect(api.updateBlenderModelDifference).toHaveBeenLastCalledWith(ID, 'difference-2', { status: 'open' }, { silent: true });
    });

    it('takes differences before the first build, and cancels a review job by its own route', async () => {
      const user = userEvent.setup();
      serve(compared({ builds: [], reviews: [], differences: [] }));
      const { unmount } = renderAt(`/3d/blender/${ID}/compare`);
      expect(await screen.findByText(/Build the model to compare/)).toBeInTheDocument();
      expect(screen.getByLabelText('Difference')).toBeEnabled();
      unmount();
      serve(compared({ jobs: [{ id: 'bj-2', kind: 'review', status: 'running', buildId: B, index: 3, total: 14, startedAt: new Date().toISOString() }] }));
      api.cancelBlenderModelReview.mockResolvedValue({ ok: true });
      renderAt(`/3d/blender/${ID}/builds`);
      const job = within(await screen.findByRole('list', { name: 'Jobs' })).getByRole('listitem');
      expect(job).toHaveTextContent('Review renders');
      await user.click(within(job).getByRole('button', { name: 'Cancel' }));
      expect(api.cancelBlenderModelReview).toHaveBeenCalledWith(ID, B, { silent: true });
      expect(api.cancelBlenderModelBuild).not.toHaveBeenCalled();
    });
  });

  describe('References', () => {
    const slot = (extra = {}) => ({ id: 'overall', role: 'overall', words: '', approvedImageId: null, file: null, locked: false, outOfDate: false, images: [], ...extra });
    const plate = (extra = {}) => slot({ id: 'closeup-1', role: 'closeup', mechanism: 'Hinge', locked: true, ...extra });
    const withReferences = (references, extra = {}) => modelState({
      referenceSource: { ingredientId: null, name: null, size: '1 m', images: [], imageMode: null, imageModelId: null }, references, ...extra,
    });
    const image = (status, extra = {}) => ({ id: 'img-1', filename: 'sheet.png', jobId: null, status, note: '', error: null, ...extra });

    it('previews the words, renders only on a click, and keeps close-ups locked', async () => {
      const user = userEvent.setup();
      serve(withReferences([slot(), plate()]));
      api.previewBlenderModelReference.mockImplementation(async (_id, _ref, { words }) => ({ sentPrompt: `SHEET ${words}`, promptAdditions: [{ id: 'model-overall-sheet', label: 'Six-view product sheet', text: 'SHEET' }], referenceImages: [], refusal: null }));
      api.renderBlenderModelReference.mockResolvedValue({ jobId: 'job-1', imageId: 'img-1' });
      renderAt(`/3d/blender/${ID}/references`);
      const overall = await screen.findByRole('region', { name: 'Overall sheet' });
      const hinge = screen.getByRole('region', { name: 'Hinge' });
      expect(within(hinge).getByRole('button', { name: 'Render' })).toBeDisabled();
      await user.type(within(overall).getByLabelText(/Your words/), 'Brass');
      await user.click(await within(overall).findByRole('button', { name: 'Show full prompt' }));
      expect(within(overall).getByText('SHEET Brass')).toBeInTheDocument();
      expect(within(overall).getByRole('button', { name: '+ Six-view product sheet' })).toBeInTheDocument();
      expect(api.renderBlenderModelReference).not.toHaveBeenCalled();
      await user.click(within(overall).getByRole('button', { name: 'Render' }));
      expect(api.renderBlenderModelReference).toHaveBeenCalledWith(ID, 'overall', 'Brass', { silent: true });
      expect(api.previewBlenderModelReference.mock.calls.every(([, refId]) => refId === 'overall')).toBe(true);
    });

    it('shows why a render would be refused and holds Render back', async () => {
      serve(withReferences([slot()]));
      api.previewBlenderModelReference.mockResolvedValue({ sentPrompt: 'SHEET', promptAdditions: [], referenceImages: [], refusal: 'Remove 1 image.' });
      renderAt(`/3d/blender/${ID}/references`);
      expect(await screen.findByText('Remove 1 image.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Render' })).toBeDisabled();
    });

    it('approves an image, sends one back with a note, and marks out-of-date plates', async () => {
      const user = userEvent.setup();
      api.previewBlenderModelReference.mockResolvedValue({ sentPrompt: 'SHEET', promptAdditions: [], referenceImages: [], refusal: null });
      serve(withReferences([slot({ images: [image('review')] })]));
      renderAt(`/3d/blender/${ID}/references`);
      await user.click(await screen.findByRole('button', { name: 'Redo…' }));
      await user.type(screen.getByLabelText(/What should change/), 'thinner');
      api.reviewBlenderModelReference.mockResolvedValue(withReferences([slot({ words: 'thinner', images: [image('superseded', { note: 'thinner' })] })]));
      await user.click(screen.getByRole('button', { name: 'Send back' }));
      expect(api.reviewBlenderModelReference).toHaveBeenLastCalledWith(ID, 'overall', 'img-1', { decision: 'redo', note: 'thinner' }, { silent: true });
      expect(await screen.findByLabelText(/Your words/)).toHaveValue('thinner');
      api.reviewBlenderModelReference.mockResolvedValue(withReferences([
        slot({ approvedImageId: 'img-1', file: 'refs/overall.png', images: [image('approved')] }),
        plate({ locked: false, outOfDate: true, approvedImageId: 'p', file: 'refs/hinge-1.png' }),
      ]));
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(within(await screen.findByRole('region', { name: 'Hinge' })).getByText('Out of date')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Copy agent brief' }));
      const brief = copyToClipboard.mock.lastCall[0];
      for (const text of ['src/refs/overall.png', 'src/refs/hinge-1.png', 'out of date', 'Real size: 1 m']) expect(brief).toContain(text);
    });

    it('opens the parts brief in the file editor', async () => {
      const user = userEvent.setup();
      serve(withReferences([slot()], { workspace: { ...modelState().workspace, hasPartsBrief: true } }));
      renderAt(`/3d/blender/${ID}/references`);
      await user.click(await screen.findByRole('button', { name: 'Edit PARTS.md' }));
      expect(screen.getByLabelText('Current location')).toHaveTextContent(`/3d/blender/${ID}/files?bfile=PARTS.md`);
    });
  });
});
