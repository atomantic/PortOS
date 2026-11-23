import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../MediaImage', () => ({ default: () => null }));
vi.mock('../videoGen/GalleryVideoPicker', () => ({ default: () => null }));

import LoomSceneMedia from './LoomSceneMedia';

afterEach(cleanup);

const node = { id: 'node-1', title: 'Scene', image: 'scene.png' };
const falJob = { jobId: 'fal-1', source: 'fal-browser', status: 'running', statusMsg: 'Generating…' };

describe('LoomSceneMedia fal.ai cancel', () => {
  it('offers Cancel only for an active fal.ai job in the non-compact view', () => {
    const onCancelFalVideo = vi.fn();
    const { rerender } = render(
      <LoomSceneMedia node={node} jobs={{ video: falJob }} onCancelFalVideo={onCancelFalVideo} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel fal\.ai/ }));
    expect(onCancelFalVideo).toHaveBeenCalledExactlyOnceWith(node, falJob);

    rerender(<LoomSceneMedia node={node} jobs={{ video: falJob }} onCancelFalVideo={onCancelFalVideo} compact />);
    expect(screen.queryByRole('button', { name: /Cancel fal\.ai/ })).toBeNull();

    rerender(<LoomSceneMedia node={node} jobs={{ video: { ...falJob, status: 'canceled' } }} onCancelFalVideo={onCancelFalVideo} />);
    expect(screen.queryByRole('button', { name: /Cancel fal\.ai/ })).toBeNull();
  });
});
