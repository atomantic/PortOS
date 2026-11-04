import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ShotStatusStrip from './ShotStatusStrip.jsx';

describe('ShotStatusStrip', () => {
  it('shows undecided takes as needing attention', () => {
    const scene = { sceneId: 's1', order: 12, referenceImageId: 'f.png', visualLayer: 'still', imageEffect: 'flash-develop', startSec: 0, endSec: 3,
      takes: [{ takeId: 'i2', kind: 'image', assetId: 'g.png', status: 'candidate' }] };
    render(<MemoryRouter><ShotStatusStrip projectId="mv-1" scenes={[scene]} ctx={{ layered: true }} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Scene 13/ }).dataset.status).toBe('attention');
  });
});
