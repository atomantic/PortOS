import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

export const OWNED_OUTPUT_PATHS = ['tailcat-serve.json'];

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'tailcat-serve.json');
    const raw = await readFile(path, 'utf8').catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw === null) return;
    const data = JSON.parse(raw);
    if (data.version !== 1) return;
    // Enrollment is explicitly operator-driven; never relabel a legacy listener
    // protected merely because this install upgraded. Preserve its identity/PSK.
    if (data.serve) data.serve = { ...data.serve, deviceEnforcement: false, devices: [] };
    await writeJsonAtomic(path, { ...data, version: 2 });
  },
};
