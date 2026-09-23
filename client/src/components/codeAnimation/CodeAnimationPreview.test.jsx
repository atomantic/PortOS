import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({ uploadGalleryVideo: vi.fn() }));

import CodeAnimationPreview, { injectAudioGlobal } from './CodeAnimationPreview';

const MESSAGES = { ready: 'ca:ready', record: 'ca:record', recorded: 'ca:recorded', progress: 'ca:progress', error: 'ca:error' };
const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>';

const renderPreview = () => render(
  <MemoryRouter>
    <CodeAnimationPreview html={HTML} audioUrl={null} messages={MESSAGES} audioGlobal="ANIMATION_AUDIO_URL" frame={{ width: 1920, height: 1080, durationSeconds: 5 }} title="Lantern" />
  </MemoryRouter>,
);

const postFromFrame = (source, data) => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
});

describe('injectAudioGlobal', () => {
  it('sets the audio global before any page script, with or without a <head>', () => {
    const withHead = injectAudioGlobal(HTML, 'ANIMATION_AUDIO_URL', 'data:audio/mpeg;base64,AA');
    expect(withHead).toContain('<head><script>window["ANIMATION_AUDIO_URL"] = "data:audio/mpeg;base64,AA";</script><title>');
    expect(injectAudioGlobal('<canvas></canvas>', 'G', 'data:x')).toBe('<script>window["G"] = "data:x";</script><canvas></canvas>');
    expect(injectAudioGlobal(HTML, 'G', null)).toBe(HTML);
  });

  it('cannot break out of the script tag through the data URL', () => {
    const out = injectAudioGlobal(HTML, 'G', 'data:x"</script><script>alert(1)//');
    expect(out).not.toContain('</script><script>alert');
    expect(out).toContain('"data:x\\"\\u003c/script>\\u003cscript>alert(1)//"');
  });
});

describe('CodeAnimationPreview', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:recorded');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('runs the page in a scripts-only sandbox and records through the postMessage handshake', async () => {
    const user = userEvent.setup();
    renderPreview();
    const frame = screen.getByTitle('Code animation preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
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
});
