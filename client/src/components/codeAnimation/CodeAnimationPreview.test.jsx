import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({ uploadGalleryVideo: vi.fn(), exportCodeAnimation: vi.fn(), cancelCodeAnimationExport: vi.fn(), getCodeAnimationPackage: vi.fn(), getCodeAnimationThreeVendor: vi.fn() }));
vi.mock('../../lib/downloadBlob', () => ({ downloadBlob: vi.fn() }));
vi.mock('../../hooks/useSseProgress', () => ({ useSseProgress: vi.fn(() => ({ latest: null })) }));

import CodeAnimationPreview, { prepareAnimationHtml } from './CodeAnimationPreview';
import { exportCodeAnimation, getCodeAnimationPackage, getCodeAnimationThreeVendor } from '../../services/api';
import { downloadBlob } from '../../lib/downloadBlob';
import { useSseProgress } from '../../hooks/useSseProgress';

const MESSAGES = { ready: 'ca:ready', record: 'ca:record', recorded: 'ca:recorded', progress: 'ca:progress', error: 'ca:error' };
const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>';

const renderPreview = ({ audioUrl = null, jobId, html = HTML } = {}) => render(
  <MemoryRouter>
    <CodeAnimationPreview html={html} audioUrl={audioUrl} messages={MESSAGES} audioGlobal="ANIMATION_AUDIO_URL" frame={{ width: 1920, height: 1080, durationSeconds: 5 }} title="Lantern" jobId={jobId} />
  </MemoryRouter>,
);

const postFromFrame = (source, data) => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
});

describe('prepareAnimationHtml', () => {
  it('installs a restrictive policy before page scripts and the audio global', () => {
    const output = prepareAnimationHtml(HTML, 'ANIMATION_AUDIO_URL', 'data:audio/mpeg;base64,AA');
    expect(output).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(output).toContain("connect-src 'none'");
    expect(output).toContain("form-action 'none'");
    expect(output).toContain('img-src data: blob:');
    expect(output).toContain('media-src data: blob:');
    expect(output).toContain('<script>window["ANIMATION_AUDIO_URL"] = "data:audio/mpeg;base64,AA";</script><title>');
  });

  it('installs the policy without a <head> and when no audio is supplied', () => {
    expect(prepareAnimationHtml('<canvas></canvas>', 'G', 'data:x'))
      .toContain('<meta http-equiv="Content-Security-Policy"');
    expect(prepareAnimationHtml(HTML, 'G', null)).toContain('<head><meta http-equiv="Content-Security-Policy"');
  });

  it('cannot break out of the script tag through the data URL', () => {
    const out = prepareAnimationHtml(HTML, 'G', 'data:x"</script><script>alert(1)//');
    expect(out).not.toContain('</script><script>alert');
    expect(out).toContain('"data:x\\"\\u003c/script>\\u003cscript>alert(1)//"');
  });
});

describe('CodeAnimationPreview', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:recorded');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('inlines the vendored three.js modules for a three film, widening the policy to data: scripts only, and downloads a standalone file (#10464)', async () => {
    const user = userEvent.setup();
    getCodeAnimationThreeVendor.mockResolvedValue({ files: [
      { path: 'three.core.js', text: 'export const REVISION = "x";' },
      { path: 'three.module.js', text: "export * from './three.core.js';" },
    ] });
    const three = "<!DOCTYPE html><html><head></head><body><script type=\"module\">import * as THREE from 'three';</script></body></html>";
    renderPreview({ html: three });
    const frame = await screen.findByTitle('Code animation preview');
    const srcDoc = frame.getAttribute('srcdoc');
    expect(srcDoc).toContain("script-src 'unsafe-inline' data:");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('type="importmap"'));
    expect(srcDoc).toContain('"three":"data:text/javascript');

    await user.click(screen.getByRole('button', { name: 'Download HTML' }));
    expect(downloadBlob.mock.calls.at(-1)[0]).toContain('type="importmap"');
    expect(downloadBlob.mock.calls.at(-1)[2]).toBe('text/html');

    // A film that does not import three never fetches the modules or gets the wider policy.
    getCodeAnimationThreeVendor.mockClear();
    renderPreview();
    expect((await screen.findAllByTitle('Code animation preview')).at(-1).getAttribute('srcdoc')).toContain("script-src 'unsafe-inline'; style-src");
    expect(getCodeAnimationThreeVendor).not.toHaveBeenCalled();
  });

  it('downloads the saved portable package through the public API', async () => {
    const user = userEvent.setup();
    const pkg = { schemaVersion: 1, revisionHash: 'example-digest', files: [] };
    getCodeAnimationPackage.mockResolvedValue(pkg);
    renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: 'Download package' }));
    expect(getCodeAnimationPackage).toHaveBeenCalledWith('job-1', { silent: true });
    expect(downloadBlob).toHaveBeenCalledWith(JSON.stringify(pkg, null, 2), 'lantern.code-animation.json', 'application/json');
    expect(screen.getByRole('button', { name: 'Download package' })).toBeEnabled();
  });

  it('runs the page in a scripts-only sandbox and records through the postMessage handshake', async () => {
    const user = userEvent.setup();
    renderPreview();
    const frame = screen.getByTitle('Code animation preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'");
    const target = frame.contentWindow;
    const postMessage = vi.spyOn(target, 'postMessage');

    await postFromFrame(target, { type: MESSAGES.ready, meta: { duration: 5 } });
    expect(screen.getByText('Animation ready')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /record \(real-time\)/i }));
    expect(postMessage).toHaveBeenCalledWith({ type: MESSAGES.record }, '*');

    // A message from any other window is ignored.
    await postFromFrame(window, { type: MESSAGES.recorded, blob: new Blob(['x']), mimeType: 'video/webm' });
    expect(screen.queryByLabelText('Recorded animation')).not.toBeInTheDocument();

    await postFromFrame(target, { type: MESSAGES.recorded, blob: new Blob(['x'], { type: 'video/webm' }), mimeType: 'video/webm' });
    expect(screen.getByLabelText('Recorded animation')).toHaveAttribute('src', 'blob:recorded');
    expect(screen.getByRole('button', { name: /save to media history/i })).toBeEnabled();
  });

  it('does not read or provide the selected audio until the user allows generated code to use it', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['audio'], { type: 'audio/wav' }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderPreview({ audioUrl: '/api/uploads/audio/example.wav' });

    expect(screen.getByRole('heading', { name: 'Preview paused' })).toBeInTheDocument();
    expect(screen.getByText(/preview is paused until you choose/i)).toBeInTheDocument();
    expect(screen.getByText(/could send that track outside PortOS/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Code animation preview')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run with audio' }));
    const frame = await screen.findByTitle('Code animation preview');
    expect(fetchMock).toHaveBeenCalledWith('/api/uploads/audio/example.wav', { credentials: 'same-origin' });
    expect(frame.getAttribute('srcdoc')).toContain('window["ANIMATION_AUDIO_URL"] = "data:audio/');
  });

  it('lets the user preview without audio and never fetches the selected track', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPreview({ audioUrl: '/api/uploads/audio/example.wav' });

    await user.click(screen.getByRole('button', { name: 'Preview without audio' }));
    const frame = await screen.findByTitle('Code animation preview');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(frame.getAttribute('srcdoc')).not.toContain('ANIMATION_AUDIO_URL');
  });
});

describe('CodeAnimationPreview frame-exact export', () => {
  it('retains sound limitations beside the completed export and clears them when switching animations', async () => {
    const user = userEvent.setup();
    const note = 'Procedural Web Audio is not rendered offline; the frame-exact export is silent.';
    exportCodeAnimation.mockResolvedValue({ jobId: 'media-1', notes: [note] });
    const { rerender } = renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    expect(screen.getByRole('status', { name: 'Export notes' })).toHaveTextContent(note);
    useSseProgress.mockReturnValue({ latest: { type: 'complete', result: { path: '/data/videos/example.mp4' } } });
    const preview = (jobId) => <MemoryRouter><CodeAnimationPreview html={HTML} jobId={jobId} /></MemoryRouter>;
    rerender(preview('job-1'));
    expect(screen.getByLabelText('Exported animation')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Export notes' })).toHaveTextContent(note);
    useSseProgress.mockReturnValue({ latest: null });
    rerender(preview('job-2'));
    expect(screen.queryByRole('status', { name: 'Export notes' })).toBeNull();
  });

  it('drops a queued export response after switching to a different animation', async () => {
    const user = userEvent.setup();
    let finish;
    exportCodeAnimation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    rerender(<MemoryRouter><CodeAnimationPreview html={HTML} jobId="job-2" /></MemoryRouter>);
    await act(async () => finish({ jobId: 'old-export', notes: ['Old soundtrack limitation'] }));
    expect(screen.queryByRole('status', { name: 'Export notes' })).toBeNull();
    expect(useSseProgress).toHaveBeenLastCalledWith(null, { enabled: false });
    expect(screen.getByRole('button', { name: /export mp4/i })).toBeEnabled();
  });

  it('offers export only for a saved job, queues it, and follows the composition job stream', async () => {
    const user = userEvent.setup();
    exportCodeAnimation.mockResolvedValue({ jobId: 'media-1', notes: [] });
    const { unmount } = renderPreview();
    expect(screen.queryByRole('button', { name: /export mp4/i })).toBeNull();
    unmount();
    renderPreview({ jobId: 'job-1' });
    await user.click(screen.getByRole('button', { name: /export mp4/i }));
    expect(exportCodeAnimation).toHaveBeenCalledWith('job-1', { silent: true });
    expect(useSseProgress).toHaveBeenLastCalledWith('/api/html-composition/media-1/events', { enabled: true });
  });
});
