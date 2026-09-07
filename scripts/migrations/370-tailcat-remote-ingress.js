import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileCore.js';
import { PORTS } from '../../server/lib/ports.js';

// Derived from the existing machine-local config. No seed and no forward-port
// rewrite: a stored forward may still target an independently upgraded peer.
export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'tailcat-serve.json');
    const raw = await readFile(path, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw === null) return;
    const data = JSON.parse(raw);
    if (data.version !== 1 || !data.serve) return;
    data.serve.localPort = PORTS.TAILCAT_INGRESS;
    data.serve.status = 'stopped';
    await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
  },
};
