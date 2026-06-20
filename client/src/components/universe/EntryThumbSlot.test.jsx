import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EntryThumbSlot from './EntryThumbSlot';

// MediaJobThumb subscribes to a socket via useMediaJobProgress. Stub the hook
// so the test doesn't need a live socket / fetch; the empty + completed
// branches don't invoke it (no jobId), so this only affects the pending case.
// `jobStatus` is mutable so a test can drive the terminal failure/cancel path.
let jobStatus = 'queued';
vi.mock('../../hooks/useMediaJobProgress', () => ({
  default: () => ({ status: jobStatus, progress: 0, step: 0, totalSteps: 0, currentImage: null, filename: null, error: jobStatus === 'failed' ? 'boom' : null }),
}));

describe('EntryThumbSlot — three-state thumbnail', () => {
  beforeEach(() => { jobStatus = 'queued'; });

  it('renders an empty placeholder with a Render button when nothing else is set', () => {
    const onRender = vi.fn();
    render(<EntryThumbSlot onRender={onRender} canRender alt="Var A render" />);
    const btn = screen.getByRole('button', { name: /render image for this item/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it('disables the empty-state button when canRender is false', () => {
    const onRender = vi.fn();
    render(<EntryThumbSlot onRender={onRender} canRender={false} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onRender).not.toHaveBeenCalled();
  });

  it('renders an <img> when imageRefs are present', () => {
    render(
      <EntryThumbSlot
        imageRefs={['render-aaa.png']}
        alt="Var B render"
        canRender={false}
      />,
    );
    const img = screen.getByRole('img', { name: 'Var B render' });
    expect(img).toHaveAttribute('src', '/data/images/render-aaa.png');
  });

  it('shows MediaJobThumb (spinner / step counter) when inFlightJobId is set', () => {
    const { container } = render(
      <EntryThumbSlot
        inFlightJobId="job-pending"
        imageRefs={[]}
        canRender={false}
      />,
    );
    // MediaJobThumb in queued/running with no preview renders a Loader2 svg —
    // assert on the spinner classname so we don't have to grep through icon
    // implementation details.
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('clears the in-flight job (onComplete(null)) when the render terminally fails', () => {
    jobStatus = 'failed';
    const onComplete = vi.fn();
    render(<EntryThumbSlot inFlightJobId="job-x" onComplete={onComplete} canRender={false} />);
    // Terminal failure yields no filename, so without this the scoped job would
    // stay pinned forever (no remount to reset it) and regenerate stays disabled.
    expect(onComplete).toHaveBeenCalledWith(null);
  });

  it('clears the in-flight job when the render is canceled', () => {
    jobStatus = 'canceled';
    const onComplete = vi.fn();
    render(<EntryThumbSlot inFlightJobId="job-y" onComplete={onComplete} canRender={false} />);
    expect(onComplete).toHaveBeenCalledWith(null);
  });

  it('does NOT clear the in-flight job for non-terminal statuses', () => {
    jobStatus = 'running';
    const onComplete = vi.fn();
    render(<EntryThumbSlot inFlightJobId="job-z" onComplete={onComplete} canRender={false} />);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
