import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ShotStatusStrip from './ShotStatusStrip.jsx';
import { ShotLockContext } from './ShotLock.jsx';

// Uniquely catches the Footage strip flagging a locked shot's leftover takes, which the Board treats as settled.
describe('ShotStatusStrip', () => {
  it('shows a locked shot as ready though its other takes were never decided', () => {
    const scene = { sceneId: 's1', order: 12, referenceImageId: 'f.png', visualLayer: 'still', imageEffect: 'flash-develop', startSec: 0, endSec: 3,
      takes: [{ takeId: 'i2', kind: 'image', assetId: 'g.png', status: 'candidate' }] };
    const strip = (locks) => (
      <MemoryRouter>
        <ShotLockContext.Provider value={{ locks, clips: { s1: null }, toggle: () => {} }}>
          <ShotStatusStrip projectId="mv-1" scenes={[scene]} ctx={{ layered: true }} />
        </ShotLockContext.Provider>
      </MemoryRouter>
    );
    const { rerender } = render(strip({ s1: 'open' }));
    expect(screen.getByRole('link', { name: /Scene 13/ }).dataset.status).toBe('attention');
    rerender(strip({ s1: 'locked' }));
    expect(screen.getByRole('link', { name: /Scene 13/ }).dataset.status).toBe('ready');
  });
});
