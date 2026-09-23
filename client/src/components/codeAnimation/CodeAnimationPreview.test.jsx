import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({ uploadGalleryVideo: vi.fn() }));

import CodeAnimationPreview, { prepareAnimationHtml } from './CodeAnimationPreview';

const MESSAGES = { ready: 'ca:ready', record: 'ca:record', recorded: 'ca:recorded', progress: 'ca:progress', error: 'ca:error' };
const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>';

const renderPreview = ({ audioUrl = null } = {}) => render(
  <MemoryRouter>
    <CodeAnimationPreview html={HTML} audioUrl={audioUrl} messages={MESSAGES} audioGlobal="ANIMATION_AUDIO_URL" frame={{ width: 1920, height: 1080, durationSeconds: 5 }} title="Lantern" />
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

    await user.click(screen.getByRole('button', { name: /record video/i }));
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
