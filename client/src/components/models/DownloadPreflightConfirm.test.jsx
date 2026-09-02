import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DownloadPreflightConfirm from './DownloadPreflightConfirm.jsx';

const assessment = {
  destPath: 'models/example.gguf',
  expectedBytes: 2 * 1024 * 1024 * 1024,
  freeBytes: 20 * 1024 * 1024 * 1024,
  requiredBytes: 2.5 * 1024 * 1024 * 1024,
  headroomBytes: 512 * 1024 * 1024,
  verdict: 'ok',
};

describe('DownloadPreflightConfirm', () => {
  it('shows size, destination, and free disk before the transfer starts', () => {
    render(
      <DownloadPreflightConfirm
        open
        assessment={assessment}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('2 GB')).toBeInTheDocument();
    expect(screen.getByText('models/example.gguf')).toBeInTheDocument();
    expect(screen.getByText('Free disk')).toBeInTheDocument();
    expect(screen.getByText('20 GB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('disables Confirm when the disk cannot hold the download', () => {
    render(
      <DownloadPreflightConfirm
        open
        assessment={{ ...assessment, verdict: 'insufficient', freeBytes: 100 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByText(/not enough free disk/i)).toBeInTheDocument();
  });

  // A leftover .partial credits its own bytes toward requiredBytes, so it
  // can read well under expectedBytes + headroom — without calling that out,
  // "Size 2 GB / Free disk 20 GB" next to an enabled Confirm reads the same
  // whether or not a resume is actually shrinking the real ask.
  it('calls out a resumed download\'s smaller remaining requirement', () => {
    render(
      <DownloadPreflightConfirm
        open
        assessment={{ ...assessment, requiredBytes: 300 * 1024 * 1024 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/resuming/i)).toBeInTheDocument();
    expect(screen.getByText('Still needed')).toBeInTheDocument();
    expect(screen.getByText('300 MB')).toBeInTheDocument();
  });

  it('calls onConfirm from the Download button', () => {
    const onConfirm = vi.fn();
    render(
      <DownloadPreflightConfirm
        open
        assessment={assessment}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
