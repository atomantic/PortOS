import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Group } from 'three';
import ArExportPanel from './ArExportPanel';

const uploadImageTo3dUsdz = vi.fn();
vi.mock('../../services/api', () => ({
  imageTo3dUsdzUrl: (id) => `/api/image-to-3d/models/${id}/usdz`,
  uploadImageTo3dUsdz: (...a) => uploadImageTo3dUsdz(...a),
}));

// The real exporter pulls three's USDZ writer and a zip library and walks GPU
// textures — none of which jsdom can run. What this suite covers is the contract
// AROUND it: what gets exported, what gets persisted, and which affordance each
// browser is offered. `supportsArQuickLook` is the switch that decides the last
// one, so it is the only thing stubbed per-test.
const usdz = vi.hoisted(() => ({ quickLook: false, bytes: null, error: null, triangles: 1000 }));
vi.mock('../../lib/usdzExport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  supportsArQuickLook: () => usdz.quickLook,
  countSceneTriangles: () => usdz.triangles,
  exportSceneToUsdz: vi.fn(async () => {
    if (usdz.error) throw usdz.error;
    return usdz.bytes;
  }),
}));
vi.mock('../../lib/qrCode', () => ({
  generateQrCodeSvg: (text) => `<svg data-qr="${text}"></svg>`,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

const record = (over = {}) => ({
  id: 'image3d-1',
  name: 'Example Beacon',
  status: 'ready',
  assetPath: '/data/image-to-3d/image3d-1/model.glb',
  usdzPath: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  usdz.quickLook = false;
  usdz.error = null;
  usdz.triangles = 1000;
  usdz.bytes = new ArrayBuffer(2048);
});

describe('ArExportPanel', () => {
  // A record with no mesh has nothing to convert — offering the action anyway
  // produces a button whose only outcome is a server 409.
  it('renders nothing until the record has a rendered mesh', () => {
    const { container } = render(
      <ArExportPanel record={record({ status: 'generating', assetPath: null })} scene={new Group()} onRecordChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The scene arrives asynchronously from the viewer; exporting before it lands
  // would throw inside the exporter instead of just waiting.
  it('disables the export until the viewer hands over the loaded scene', () => {
    render(<ArExportPanel record={record()} scene={null} onRecordChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /export for ar/i })).toBeDisabled();
  });

  it('exports the loaded scene and persists the bytes', async () => {
    const onRecordChange = vi.fn();
    const exported = record({ usdzPath: '/data/image-to-3d/image3d-1/model.usdz' });
    uploadImageTo3dUsdz.mockResolvedValue(exported);
    render(<ArExportPanel record={record()} scene={new Group()} onRecordChange={onRecordChange} />);

    fireEvent.click(screen.getByRole('button', { name: /export for ar/i }));
    await waitFor(() => expect(uploadImageTo3dUsdz).toHaveBeenCalled());
    const [id, bytes, options] = uploadImageTo3dUsdz.mock.calls[0];
    expect(id).toBe('image3d-1');
    expect(bytes).toBe(usdz.bytes);
    // The component owns its own error toast, so the request must not raise a
    // second one from apiCore.
    expect(options).toMatchObject({ silent: true });
    expect(onRecordChange).toHaveBeenCalledWith(exported);
  });

  // A mesh far above the AR budget still exports — but silently handing back a
  // file that opens to an empty room is the failure this warning exists to
  // prevent, and the count is the only thing the user can act on.
  it('warns with the triangle count when the mesh is above the AR budget', async () => {
    usdz.triangles = 900_000;
    uploadImageTo3dUsdz.mockResolvedValue(record({ usdzPath: '/x.usdz' }));
    render(<ArExportPanel record={record()} scene={new Group()} onRecordChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /export for ar/i }));
    await waitFor(() => expect(uploadImageTo3dUsdz).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('900,000'), expect.anything());
  });

  it('surfaces a conversion failure without persisting anything', async () => {
    usdz.error = new Error('USDZ does not support negative scales');
    render(<ArExportPanel record={record()} scene={new Group()} onRecordChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /export for ar/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('negative scales')));
    expect(uploadImageTo3dUsdz).not.toHaveBeenCalled();
  });

  // The stored artifact is the whole reason the bytes are persisted rather than
  // handed back as a blob: revisiting the record must reuse it, never silently
  // re-run a multi-second conversion.
  it('reuses a stored export instead of re-exporting on load', async () => {
    render(
      <ArExportPanel record={record({ usdzPath: '/data/image-to-3d/image3d-1/model.usdz' })} scene={new Group()} onRecordChange={vi.fn()} />,
    );
    expect(uploadImageTo3dUsdz).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /re-export for ar/i })).toBeInTheDocument();
  });

  // Labelling a desktop button "View in AR" is a promise the browser cannot keep,
  // so the affordance has to differ — a QR bridge to the phone plus a plain
  // download, and NO AR anchor.
  it('offers a QR bridge and a download where AR Quick Look is unavailable', () => {
    render(
      <ArExportPanel record={record({ usdzPath: '/data/image-to-3d/image3d-1/model.usdz' })} scene={new Group()} onRecordChange={vi.fn()} />,
    );
    expect(screen.queryByRole('link', { name: /view in ar/i })).toBeNull();
    expect(screen.getByRole('link', { name: /download ar model/i }))
      .toHaveAttribute('href', '/api/image-to-3d/models/image3d-1/usdz');
    // Absolute, because the QR is scanned by a DIFFERENT device — a relative path
    // would resolve against whatever the phone happens to have open.
    expect(screen.getByLabelText('QR code linking to the AR model').innerHTML)
      .toContain('http://localhost:3000/api/image-to-3d/models/image3d-1/usdz');
  });

  it('renders the rel="ar" anchor on a browser that implements AR Quick Look', () => {
    usdz.quickLook = true;
    render(
      <ArExportPanel record={record({ usdzPath: '/data/image-to-3d/image3d-1/model.usdz' })} scene={new Group()} onRecordChange={vi.fn()} />,
    );
    const anchor = screen.getByRole('link', { name: 'View in AR' });
    expect(anchor).toHaveAttribute('rel', 'ar');
    expect(anchor).toHaveAttribute('href', '/api/image-to-3d/models/image3d-1/usdz');
    // Safari only engages the handoff when the anchor's only child is an <img>;
    // a text node inside it silently turns this back into a download.
    expect(anchor.children).toHaveLength(1);
    expect(anchor.firstElementChild.tagName).toBe('IMG');
    expect(screen.queryByLabelText('QR code linking to the AR model')).toBeNull();
  });
});
