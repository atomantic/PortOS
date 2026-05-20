import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { certPaths } from './certPaths.js';

describe('certPaths', () => {
  it('returns dir + cert/key/meta paths anchored at <dataDir>/certs', () => {
    const dataDir = '/tmp/portos-data';
    expect(certPaths(dataDir)).toEqual({
      dir: join(dataDir, 'certs'),
      cert: join(dataDir, 'certs', 'cert.pem'),
      key: join(dataDir, 'certs', 'key.pem'),
      meta: join(dataDir, 'certs', 'meta.json'),
    });
  });

  it('joins relative dataDir without normalizing away the prefix', () => {
    const { dir, cert } = certPaths('data');
    expect(dir).toBe(join('data', 'certs'));
    expect(cert).toBe(join('data', 'certs', 'cert.pem'));
  });
});
