// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveApiScheme } from '../../vite.config.js';

const configDir = resolve('checkout', 'client');
const checkoutCert = resolve(configDir, '..', 'data', 'certs', 'cert.pem');
const primaryCert = resolve('primary', 'data', 'certs', 'cert.pem');

describe('Vite API scheme resolution', () => {
  it.each(['http', 'https'])('honors the explicit %s override', override => {
    expect(resolveApiScheme({ override, configDir, exists: () => false })).toBe(override);
  });

  it('uses the current checkout certificate when present', () => {
    expect(resolveApiScheme({
      configDir,
      exists: path => path === checkoutCert,
      getPrimaryDir: () => resolve('primary'),
    })).toBe('https');
  });

  it('uses the primary checkout certificate from a linked worktree', () => {
    expect(resolveApiScheme({
      configDir,
      exists: path => path === primaryCert,
      getPrimaryDir: () => resolve('primary'),
    })).toBe('https');
  });

  it('keeps ordinary checkouts on HTTP when neither checkout has a certificate', () => {
    expect(resolveApiScheme({
      configDir,
      exists: () => false,
      getPrimaryDir: () => null,
    })).toBe('http');
  });
});
