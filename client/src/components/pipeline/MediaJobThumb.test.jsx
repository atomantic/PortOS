import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MediaJobThumb from './MediaJobThumb';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';

vi.mock('../../hooks/useMediaJobProgress', () => ({ default: vi.fn() }));

it('does not publish a retained original as a completed render after failed-job hydration', () => {
  const onFilename = vi.fn();
  useMediaJobProgress.mockReturnValue({ status: 'failed', filename: 'saved-original.png', error: 'Saving failed' });
  const view = render(<MediaJobThumb jobId="example-job" onFilename={onFilename} />);
  expect(screen.getByText('Saving failed')).toBeInTheDocument();
  expect(onFilename).not.toHaveBeenCalled();
  useMediaJobProgress.mockReturnValue({ status: 'completed', filename: 'saved-original.png' });
  view.rerender(<MediaJobThumb jobId="example-job" onFilename={onFilename} />);
  expect(onFilename).toHaveBeenCalledWith('saved-original.png');
});
