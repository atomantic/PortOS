import { describe, it, expect } from 'vitest';
import {
  PORTOS_ROOT_TOKEN,
  expandPortosRootToken,
  expandPortosRootInApp,
  containsPortosRootToken,
} from './portosRootPlaceholder.js';

describe('portosRootPlaceholder', () => {
  it('expands the token and leaves other strings alone', () => {
    expect(expandPortosRootToken(`${PORTOS_ROOT_TOKEN}/icon.png`, '/opt/PortOS'))
      .toBe('/opt/PortOS/icon.png');
    expect(expandPortosRootToken('/already/real', '/opt/PortOS')).toBe('/already/real');
    expect(expandPortosRootToken(42, '/opt/PortOS')).toBe(42);
  });

  it('expands every top-level string field on an app record', () => {
    const { app, changed } = expandPortosRootInApp({
      repoPath: PORTOS_ROOT_TOKEN,
      appIconPath: `${PORTOS_ROOT_TOKEN}/client/public/portos-logo.png`,
      name: 'PortOS',
      nested: { path: PORTOS_ROOT_TOKEN },
    }, '/mock/root');

    expect(changed).toBe(true);
    expect(app.repoPath).toBe('/mock/root');
    expect(app.appIconPath).toBe('/mock/root/client/public/portos-logo.png');
    expect(app.name).toBe('PortOS');
    // Nested objects are left alone — apps.json only uses the token at top level.
    expect(app.nested).toEqual({ path: PORTOS_ROOT_TOKEN });
  });

  it('reports unchanged when no token is present', () => {
    const input = { repoPath: '/custom/checkout', name: 'Other' };
    const { app, changed } = expandPortosRootInApp(input, '/mock/root');
    expect(changed).toBe(false);
    expect(app).toEqual(input);
  });

  it('detects the token', () => {
    expect(containsPortosRootToken(`x${PORTOS_ROOT_TOKEN}`)).toBe(true);
    expect(containsPortosRootToken('/real')).toBe(false);
    expect(containsPortosRootToken(null)).toBe(false);
  });
});
