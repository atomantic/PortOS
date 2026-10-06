import { join } from 'path';
import { readFile } from 'fs/promises';
import { ensureDir, atomicWrite } from '../lib/fileUtils.js';
import { publishRuntimeFiles } from '../lib/runtimeFilePublication.js';

export async function persistRunnerCompletion(agentsDir, agentId, output, metadata) {
  const agentDir = join(agentsDir, agentId);
  return publishRuntimeFiles([join(agentDir, 'output.txt'), join(agentDir, 'metadata.json')], async () => {
    await ensureDir(agentDir);
    // atomicWrite (temp + rename): a crash mid-write must not leave a torn file
    // that the next completion attempt then chokes on.
    await atomicWrite(join(agentDir, 'output.txt'), output);
    if (!metadata) return;
    const metadataPath = join(agentDir, 'metadata.json');
    const existing = await readFile(metadataPath, 'utf-8').then(JSON.parse).catch(err => {
      if (err.code === 'ENOENT') return {};
      // Unreadable/corrupt prior metadata must not block recording the terminal
      // result — the new fields below are the authoritative completion evidence.
      if (err instanceof SyntaxError) {
        console.warn(`⚠️ Agent ${agentId} metadata.json is corrupt (${err.message}) — rewriting from completion data`);
        return {};
      }
      throw err;
    });
    await atomicWrite(metadataPath, {
      ...existing, agentId, ...metadata, outputSize: Buffer.byteLength(output),
    });
  });
}
