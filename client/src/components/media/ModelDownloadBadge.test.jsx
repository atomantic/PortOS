import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelDownloadBadge, { deriveSizeEstimate } from './ModelDownloadBadge.jsx';

describe('deriveSizeEstimate', () => {
  it('preserves decimal and binary gigabyte labels', () => {
    expect(deriveSizeEstimate('Example model (~8 GB)')).toBe('~8 GB');
    expect(deriveSizeEstimate('Wan 2.2 (~16.9 GiB download)')).toBe('~16.9 GiB');
  });

  it('returns null when no estimate is embedded', () => {
    expect(deriveSizeEstimate('Example model')).toBeNull();
    expect(deriveSizeEstimate(null)).toBeNull();
  });
});

describe('ModelDownloadBadge', () => {
  it('disables a gated download and explains why', () => {
    const onDownload = vi.fn();
    render(<ModelDownloadBadge
      status={{ repo: 'example/model', cached: false }}
      onDownload={onDownload}
      disabled
      disabledReason="Accept the model terms first"
      disabledReasonId="model-terms"
    />);
    const button = screen.getByRole('button', { name: /Download/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Accept the model terms first');
    expect(button).toHaveAttribute('aria-describedby', 'model-terms');
    fireEvent.click(button);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('does not treat a 1-file start as 100%', () => {
    render(<ModelDownloadBadge
      status={{
        repo: 'example/encoder',
        cached: false,
        downloading: true,
        progress: {
          type: 'progress',
          stage: 'download',
          progress: 0,
          step: 1,
          total: 1,
          file: 'qwen3vl_32b.safetensors',
        },
      }}
    />);
    expect(screen.getByText('Downloading…')).toBeInTheDocument();
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
    expect(screen.getByText('1/1 · qwen3vl_32b.safetensors')).toBeInTheDocument();
  });

  it('shows byte progress for a large single-file pull', () => {
    render(<ModelDownloadBadge
      status={{
        repo: 'example/encoder',
        cached: false,
        downloading: true,
        progress: {
          type: 'progress',
          stage: 'download',
          progress: 0.5,
          step: 1,
          total: 1,
          downloaded: 24 * 1024 * 1024 * 1024,
          totalBytes: 48 * 1024 * 1024 * 1024,
          file: 'qwen3vl_32b.safetensors',
        },
      }}
    />);
    expect(screen.getByText('Downloading… 50%')).toBeInTheDocument();
    expect(screen.getByText('24 GB / 48 GB')).toBeInTheDocument();
  });

  it('omits the file counter when the emitter does not count files', () => {
    render(<ModelDownloadBadge
      status={{
        repo: 'example/encoder',
        cached: false,
        downloading: true,
        progress: { type: 'progress', stage: 'download', progress: 0.25, file: 'text_encoder/model.safetensors' },
      }}
    />);
    expect(screen.getByText('text_encoder/model.safetensors')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('labels the post-transfer commit as verifying', () => {
    render(<ModelDownloadBadge
      status={{
        repo: 'example/encoder',
        cached: false,
        downloading: true,
        progress: {
          type: 'progress',
          stage: 'verify',
          progress: 1,
          step: 1,
          total: 1,
          file: 'qwen3vl_32b.safetensors',
        },
      }}
    />);
    expect(screen.getByText('Verifying… 100%')).toBeInTheDocument();
  });
});

describe('ModelDownloadBadge runtime issue', () => {
  it('does not call cached weights available when their runtime fails its check', () => {
    const onRepairRuntime = vi.fn();
    render(<ModelDownloadBadge
      status={{ repo: 'example/model', cached: true, sizeBytes: 1024 }}
      runtimeIssue="Runtime needs repair"
      onRepairRuntime={onRepairRuntime}
      repairLabel="Repair example runtime"
    />);
    expect(screen.queryByText(/^Available/)).not.toBeInTheDocument();
    expect(screen.getByText(/Weights downloaded.*runtime unavailable/)).toHaveAttribute('title', 'Runtime needs repair');
    fireEvent.click(screen.getByRole('button', { name: /Repair example runtime/ }));
    expect(onRepairRuntime).toHaveBeenCalledOnce();
  });

  it('keeps the plain Available state when the runtime is fine', () => {
    render(<ModelDownloadBadge status={{ repo: 'example/model', cached: true }} />);
    expect(screen.getByText('Available')).toBeInTheDocument();
  });
});
