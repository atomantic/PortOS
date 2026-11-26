/** Stage and validate Tailscale TLS material before publishing it at the canonical cert paths. */
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { certExpiresAtFromPem, readCertMetaAsync } from './certMeta.js';
import { createKeyCachedQueue } from '../server/lib/createKeyCachedQueue.js';

export const TAILSCALE_CERT_TIMEOUT_MS = 60_000;

const queueInstall = createKeyCachedQueue();

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function hasMatchingKey(cert, key) {
  if (!cert?.length || !key?.length) return false;
  try {
    createSecureContext({ cert, key });
    return true;
  } catch {
    return false;
  }
}

export function installTailscaleCert(paths, options) {
  // Runtime provisioning and renewal share the same installed files.
  return queueInstall(paths.dir, () => stageAndInstall(paths, options));
}

async function stageAndInstall(paths, { hostname, runCert, now = Date.now }) {
  await mkdir(paths.dir, { recursive: true });
  const stage = await mkdtemp(join(paths.dir, '.stage-'));
  try {
    const stagedCert = join(stage, 'cert.pem');
    const stagedKey = join(stage, 'key.pem');
    const stagedMeta = join(stage, 'meta.json');
    await runCert(['cert', `--cert-file=${stagedCert}`, `--key-file=${stagedKey}`, hostname]);
    const [cert, key] = await Promise.all([
      readIfPresent(stagedCert),
      readIfPresent(stagedKey)
    ]);
    if (!cert || !key) {
      throw Object.assign(new Error('tailscale cert returned success but cert files are missing.'), {
        code: 'cert-files-missing'
      });
    }
    if (!hasMatchingKey(cert, key)) {
      throw Object.assign(new Error('tailscale cert returned an invalid certificate or private key.'), {
        code: 'cert-pair-invalid'
      });
    }
    await chmod(stagedKey, 0o600);

    const credentials = { cert, key };

    // Tailscale writes the cached pair even when it hasn't renewed the cert.
    // An identical cert with a missing or unusable key still needs repair.
    const currentCert = await readIfPresent(paths.cert);
    const changed = !currentCert?.equals(cert) ||
      !hasMatchingKey(cert, await readIfPresent(paths.key));
    const expiresAt = certExpiresAtFromPem(cert);
    if (!changed) {
      const currentMeta = await readCertMetaAsync(paths.meta);
      if (currentMeta?.mode === 'tailscale' && currentMeta.hostname === hostname) {
        return { changed, credentials, expiresAt };
      }
    }

    const { mtimeMs: certMtime } = await stat(changed ? stagedCert : paths.cert);
    await writeFile(stagedMeta, JSON.stringify({
      mode: 'tailscale',
      hostname,
      issuedAt: new Date(now()).toISOString(),
      expiresAt,
      certMtime
    }, null, 2));

    // Each rename stays on the same filesystem. Metadata is published last.
    if (changed) {
      await rename(stagedKey, paths.key);
      await rename(stagedCert, paths.cert);
    }
    await rename(stagedMeta, paths.meta);
    return { changed, credentials, expiresAt };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
