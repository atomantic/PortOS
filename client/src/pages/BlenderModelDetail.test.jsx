/**
 * One Blender model's page through the real hook, tabs and film Files/Jobs tabs:
 * only the API module, the socket and the WebGL viewer are doubled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const socketHandlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({ default: {
  on: (event, fn) => { if (!socketHandlers.has(event)) socketHandlers.set(event, new Set()); socketHandlers.get(event).add(fn); },
  off: (event, fn) => socketHandlers.get(event)?.delete(fn),
} }));
vi.mock('../components/media/GlbViewer', () => ({
  default: ({ src, downloadHref, isolateNode }) => <div data-testid="glb-viewer" data-download={downloadHref || ''} data-part={isolateNode || ''}>{src}</div>,
}));
vi.mock('../lib/clipboard.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../services/apiBlenderModels.js', () => ({
  getBlenderModel: vi.fn(), createBlenderModel: vi.fn(), updateBlenderModel: vi.fn(), deleteBlenderModel: vi.fn(), scaffoldBlenderModel: vi.fn(),
  listBlenderModelFiles: vi.fn(), readBlenderModelFile: vi.fn(), writeBlenderModelFile: vi.fn(), deleteBlenderModelFile: vi.fn(),
  buildBlenderModel: vi.fn(), cancelBlenderModelBuild: vi.fn(), openBlenderModelBuild: vi.fn(), publishBlenderModelBuild: vi.fn(),
  getBlenderModelBuildReport: vi.fn(), getBlenderModelBuildLog: vi.fn(),
  blenderModelBuildFileUrl: (id, buildId, name) => `/api/blender-models/${id}/builds/${buildId}/files/${name}`,
  blenderModelAssetUrl: (id) => `/api/blender-models/${id}/asset`,
}));
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
});
