import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const stream = vi.hoisted(() => ({ latest: null, closed: false, calls: [] }));
vi.mock('../../hooks/useSseProgress', () => ({
  useSseProgress: (url, options) => {
    stream.calls.push({ url, options });
    return { latest: url ? stream.latest : null, closed: url ? stream.closed : false };
  },
}));
vi.mock('../../services/apiImageVideo', () => ({ realesrganInstallUrl: () => '/api/video-gen/upscale/realesrgan/install' }));
vi.mock('../ui/Toast');

const { default: RealesrganInstallButton } = await import('./RealesrganInstallButton');
const { default: toast } = await import('../ui/Toast');

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(stream, { latest: null, closed: false, calls: [] });
});

describe('RealesrganInstallButton', () => {
  it('opens the install stream only when pressed, shows progress, and reports completion', () => {
    const onInstalled = vi.fn();
    const view = render(<RealesrganInstallButton installTarget={{ sizeBytes: 51_817_124 }} onInstalled={onInstalled} />);
    expect(stream.calls.every((call) => call.url === null && call.options.enabled === false)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Install Real-ESRGAN \(/ }));
    expect(stream.calls.at(-1)).toMatchObject({ url: '/api/video-gen/upscale/realesrgan/install', options: { enabled: true, method: 'POST' } });

    stream.latest = { type: 'progress', progress: 0.42 };
    view.rerender(<RealesrganInstallButton installTarget={{ sizeBytes: 51_817_124 }} onInstalled={onInstalled} />);
    expect(screen.getByRole('status').textContent).toContain('Downloading 42%');

    Object.assign(stream, { latest: { type: 'complete', message: 'Real-ESRGAN (ncnn Vulkan) ready on Example GPU' }, closed: true });
    view.rerender(<RealesrganInstallButton installTarget={{ sizeBytes: 51_817_124 }} onInstalled={onInstalled} />);
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Real-ESRGAN (ncnn Vulkan) ready on Example GPU');
    expect(screen.getByRole('button', { name: /Install Real-ESRGAN/ })).toBeInTheDocument();
  });

  it('reports a failed install without claiming success', () => {
    const onInstalled = vi.fn();
    const view = render(<RealesrganInstallButton onInstalled={onInstalled} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Real-ESRGAN' }));
    Object.assign(stream, { latest: { type: 'error', message: 'Download failed SHA-256 verification' }, closed: true });
    view.rerender(<RealesrganInstallButton onInstalled={onInstalled} />);
    expect(toast.error).toHaveBeenCalledWith('Download failed SHA-256 verification');
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
