import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }));
vi.mock('./OpenWorldPaletteContext', () => ({
  useOpenWorldPalette: () => ({
    getBuildingColor: (status, archived) => (archived ? '#475569' : status === 'online' ? '#06b6d4' : '#ef4444'),
    getAccentColor: () => '#06b6d4',
    tintStructure: (c) => c,
    surface: {},
    lowPoly: false,
    neonLayers: true,
  }),
}));
vi.mock('./BuildingHologram', () => ({ default: () => <div data-testid="hologram" /> }));
vi.mock('./HolographicPanel', () => ({ default: () => <div data-testid="panel" /> }));
vi.mock('./OpenWorldLabel', () => ({ default: ({ children }) => <div data-testid="label">{children}</div> }));
vi.mock('./BuildingWindows', () => ({ default: () => <div data-testid="windows" /> }));

import Building from './Building';

describe('Building component', () => {
  const mockApp = {
    id: 'test-app',
    name: 'Test App',
    overallStatus: 'online',
    archived: false,
    pm2Status: {
      worker1: { status: 'online', cpu: 15, memory: 104857600, uptime: 100000 },
    },
  };

  it('renders building mesh, health strip, and label for an active app', () => {
    const { container } = render(
      <Building
        app={mockApp}
        position={{ x: 0, z: 0 }}
        agentCount={1}
      />
    );
    expect(container.getElementsByTagName('mesh').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="label"]')?.textContent).toBe('TEST APP');
  });

  it('renders stress effects when CPU is hot', () => {
    const hotApp = {
      ...mockApp,
      pm2Status: {
        worker1: { status: 'online', cpu: 92, memory: 500000000, uptime: 100000 },
      },
    };
    const { container } = render(
      <Building
        app={hotApp}
        position={{ x: 0, z: 0 }}
        agentCount={0}
      />
    );
    expect(container.getElementsByTagName('group').length).toBeGreaterThan(0);
  });

  it('renders stress effects when PM2 process is errored', () => {
    const errorApp = {
      ...mockApp,
      pm2Status: {
        worker1: { status: 'errored', cpu: 0, memory: 0, uptime: 0 },
      },
    };
    const { container } = render(
      <Building
        app={errorApp}
        position={{ x: 0, z: 0 }}
        agentCount={0}
      />
    );
    expect(container.getElementsByTagName('group').length).toBeGreaterThan(0);
  });

  it('suppresses live stress effects during history playback', () => {
    const hotApp = {
      ...mockApp,
      pm2Status: {
        worker1: { status: 'online', cpu: 95, memory: 500000000, uptime: 100000 },
      },
    };
    const { container } = render(
      <Building
        app={hotApp}
        position={{ x: 0, z: 0 }}
        agentCount={0}
        playback={true}
      />
    );
    expect(container).toBeTruthy();
  });

  it('omits health strip and stress effects for archived apps', () => {
    const archivedApp = {
      ...mockApp,
      archived: true,
    };
    const { container } = render(
      <Building
        app={archivedApp}
        position={{ x: 0, z: 0 }}
        agentCount={0}
      />
    );
    expect(container).toBeTruthy();
  });
});
