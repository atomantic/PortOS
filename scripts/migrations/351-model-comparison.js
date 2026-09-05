/** Seed the public reference catalog only when absent. No provider calls. */
import { copyFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
export default {
  async up({ rootDir }) {
    await copyFile(join(rootDir, 'data.reference/model-comparison.json'), join(rootDir, 'data/model-comparison.json'), constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    return { success: true };
  },
};
