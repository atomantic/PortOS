import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BucketChipStrip from './BucketChipStrip.jsx';

describe('BucketChipStrip', () => {
  it('renders nothing when there are no buckets or extra chips', () => {
    const { container } = render(
      <BucketChipStrip buckets={[]} activeBucket="" setBucket={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders All + humanized bucket pills and toggles selection', async () => {
    const setBucket = vi.fn();
    render(
      <BucketChipStrip buckets={['deep_space']} activeBucket="" setBucket={setBucket} />,
    );
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    const pill = screen.getByRole('button', { name: 'Deep Space' });
    await userEvent.click(pill);
    expect(setBucket).toHaveBeenCalledWith('deep_space');
  });

  it('clicking the active bucket clears the selection', async () => {
    const setBucket = vi.fn();
    render(
      <BucketChipStrip buckets={['heroes']} activeBucket="heroes" setBucket={setBucket} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Heroes' }));
    expect(setBucket).toHaveBeenCalledWith('');
  });

  it('renders caller-supplied extra chips (e.g. the Canon pseudo-bucket)', async () => {
    const setBucket = vi.fn();
    render(
      <BucketChipStrip
        buckets={[]}
        activeBucket=""
        setBucket={setBucket}
        extraChips={[{ key: 'canon', label: 'Canon (3)' }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Canon (3)' }));
    expect(setBucket).toHaveBeenCalledWith('canon');
  });
});
