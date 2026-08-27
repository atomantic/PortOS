import { describe, it, expect } from 'vitest';
import { computeAppMetrics, cpuTone, hasPm2Error, buildingSignalTone } from './openWorldAppMetrics';

describe('computeAppMetrics', () => {
  it('sums cpu/memory across online processes and takes the minimum uptime', () => {
    const app = {
      pm2Status: {
        web: { status: 'online', cpu: 12.4, memory: 150 * 1024 * 1024, uptime: 5000 },
        worker: { status: 'online', cpu: 30.2, memory: 50 * 1024 * 1024, uptime: 1000 },
      },
    };
    expect(computeAppMetrics(app)).toMatchObject({
      hasMetrics: true,
      totalProcs: 2,
      onlineProcs: 2,
      cpuPercent: 42.6,
      memBytes: 200 * 1024 * 1024,
      // The youngest online process bounds "how long the whole app has been stable".
      uptimeMs: 1000,
    });
  });

  it('excludes non-online processes from live usage but keeps their restarts', () => {
    const app = {
      pm2Status: {
        web: { status: 'online', cpu: 10, memory: 1024, uptime: 60_000 },
        worker: { status: 'errored', cpu: 99, memory: 999_999, uptime: 5, restarts: 3, unstableRestarts: 2 },
      },
    };
    const m = computeAppMetrics(app);
    expect(m.onlineProcs).toBe(1);
    expect(m.cpuPercent).toBe(10);
    expect(m.memBytes).toBe(1024);
    expect(m.uptimeMs).toBe(60_000);
    expect(m.restarts).toBe(3);
    expect(m.unstableRestarts).toBe(2);
  });

  it('reports null cpu/uptime (not zero) when nothing is online', () => {
    const app = {
      pm2Status: {
        web: { status: 'stopped', cpu: 0, memory: 0 },
      },
    };
    const m = computeAppMetrics(app);
    expect(m.hasMetrics).toBe(true);
    expect(m.cpuPercent).toBeNull();
    expect(m.uptimeMs).toBeNull();
    expect(m.memBytes).toBe(0);
  });

  it('flags no metrics for non-PM2 / failed-read apps', () => {
    expect(computeAppMetrics({}).hasMetrics).toBe(false);
    expect(computeAppMetrics({ pm2Status: {} }).hasMetrics).toBe(false);
    expect(computeAppMetrics(null).hasMetrics).toBe(false);
  });

  it('tolerates missing numeric fields on status entries', () => {
    const app = { pm2Status: { web: { status: 'online' } } };
    const m = computeAppMetrics(app);
    expect(m.cpuPercent).toBe(0);
    expect(m.memBytes).toBe(0);
    expect(m.uptimeMs).toBeNull();
  });
});

describe('cpuTone', () => {
  it('buckets by threshold with an idle bucket for absent data', () => {
    expect(cpuTone(null)).toBe('idle');
    expect(cpuTone(0)).toBe('calm');
    expect(cpuTone(39.9)).toBe('calm');
    expect(cpuTone(40)).toBe('busy');
    expect(cpuTone(84.9)).toBe('busy');
    expect(cpuTone(85)).toBe('hot');
  });
});

describe('hasPm2Error', () => {
  it('treats errored and error process statuses as a PM2 error', () => {
    expect(hasPm2Error({ web: { status: 'online' } })).toBe(false);
    expect(hasPm2Error({ web: { status: 'errored' } })).toBe(true);
    expect(hasPm2Error({ web: { status: 'error' } })).toBe(true);
    expect(hasPm2Error(null)).toBe(false);
  });
});

describe('buildingSignalTone', () => {
  const hotMetrics = { hasMetrics: true, cpuPercent: 92, unstableRestarts: 0 };
  const calmMetrics = { hasMetrics: true, cpuPercent: 12, unstableRestarts: 0 };

  it('maps a healthy online app to a calm green LED with no rooftop effects', () => {
    expect(buildingSignalTone({
      status: 'online',
      metrics: calmMetrics,
      pm2Status: { web: { status: 'online' } },
    })).toMatchObject({
      tone: 'online',
      color: '#10b981',
      pulsing: false,
      smoke: false,
      sparks: false,
    });
  });

  it('raises smoke on a hot CPU and sparks on a PM2 error', () => {
    expect(buildingSignalTone({
      status: 'online',
      metrics: hotMetrics,
      pm2Status: { web: { status: 'online' } },
    })).toMatchObject({ tone: 'hot', pulsing: true, smoke: true, sparks: false });

    expect(buildingSignalTone({
      status: 'online',
      metrics: calmMetrics,
      pm2Status: { web: { status: 'errored' } },
    })).toMatchObject({ tone: 'errored', pulsing: true, smoke: false, sparks: true });
  });

  it('hides live CPU smoke during playback while keeping the snapshot status LED', () => {
    expect(buildingSignalTone({
      status: 'online',
      metrics: hotMetrics,
      pm2Status: { web: { status: 'online' } },
      playback: true,
    })).toMatchObject({
      tone: 'online',
      pulsing: false,
      smoke: false,
      sparks: false,
    });
  });

  it('keeps a snapshot error LED during playback without live sparks or pulse', () => {
    expect(buildingSignalTone({
      status: 'online',
      metrics: hotMetrics,
      pm2Status: { web: { status: 'errored' } },
      playback: true,
    })).toMatchObject({
      tone: 'errored',
      color: '#f43f5e',
      pulsing: false,
      smoke: false,
      sparks: false,
    });
  });
});
