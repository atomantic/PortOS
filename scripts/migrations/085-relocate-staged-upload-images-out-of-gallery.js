/**
 * Relocate staged init/reference upload images out of the gallery directory.
 *
 * Why:
 *   Before this change, `prepareGenerateParams` staged uploaded INIT images into
 *   `data/images` — the same directory `listGallery()` enumerates. Every i2i /
 *   edit render therefore dropped a fresh `init-<uuid>.png` into the gallery dir,
 *   and since the gallery lists every `.png` under `data/images`, each staged
 *   copy surfaced as a duplicate "(no prompt)" card (the original bug report:
 *   the reference/init image duplicated into the gallery on every render).
 *
 *   The code fix routes new init uploads into `data/image-refs` (the sibling dir
 *   that is served statically but NOT enumerated by the gallery — where multi-
 *   reference uploads already land). This migration cleans up the orphans that
 *   prior renders already left behind in `data/images` on existing installs.
 *
 * What it does:
 *   For each file in `data/images` whose name matches a staged-upload pattern
 *   (`init-<uuid>` or `ref-<uuid>` with an image extension) AND has NO sidecar
 *   metadata, MOVE it to `data/image-refs`. The two conditions together are the
 *   safe discriminator: a genuinely generated gallery image is named
 *   `<jobId>.png` (no `init-`/`ref-` prefix) and ALWAYS carries a
 *   `<jobId>.metadata.json` sidecar. A staged input upload has the prefix and
 *   never gets a sidecar. We require both so a user who happened to import a file
 *   literally named `init-….png` WITH a sidecar (treating it as a real gallery
 *   entry) is left untouched.
 *
 *   Files are MOVED, not deleted — they remain reachable as init/reference
 *   inputs from `data/image-refs` (resolveImageInputPath accepts that root), and
 *   metadata sidecars on generated images reference them by basename only, which
 *   keeps resolving. Lineage is preserved; nothing is destroyed.
 *
 * Dependency-light (fs + path only), per the migration convention.
 *
 * Idempotent: a second run finds no matching files in `data/images` (they were
 * already moved) → no-op. A collision in the target dir (a same-named file
 * already in image-refs — effectively impossible with UUIDs) is left in place
 * and logged, never overwritten.
 */

import { mkdir, readdir, rename, stat } from 'fs/promises';
import { join } from 'path';

const IMAGES_DIR = 'images';
const IMAGE_REFS_DIR = 'image-refs';

// `init-<uuid>` / `ref-<uuid>` with a decodable image extension. The UUID shape
// is loose on purpose (any hex/dash run) so we still catch files staged by older
// builds; the no-sidecar requirement below is what makes the match safe.
const STAGED_UPLOAD_RE = /^(?:init|ref)-[0-9a-f-]+\.(?:png|jpe?g|webp)$/i;

const fileExists = (p) => stat(p).then(() => true).catch(() => false);

// Generated gallery images carry a sidecar at `<name-without-ext>.metadata.json`
// OR the alternate `<name>.metadata.json` shape (see readImageSidecar). A staged
// input upload has neither.
async function hasSidecar(dir, filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  return (
    (await fileExists(join(dir, `${base}.metadata.json`))) ||
    (await fileExists(join(dir, `${filename}.metadata.json`)))
  );
}

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const imagesDir = join(dataDir, IMAGES_DIR);
    const refsDir = join(dataDir, IMAGE_REFS_DIR);

    if (!(await fileExists(imagesDir))) {
      console.log('🖼️ migration 085: no data/images dir — fresh install, no-op');
      return { ok: true, reason: 'no-images-dir' };
    }

    const entries = await readdir(imagesDir, { withFileTypes: true }).catch(() => []);
    const candidates = entries
      .filter((e) => e.isFile() && STAGED_UPLOAD_RE.test(e.name))
      .map((e) => e.name);

    if (candidates.length === 0) {
      console.log('🖼️ migration 085: no staged-upload files in gallery dir — no-op');
      return { ok: true, reason: 'none' };
    }

    let moved = 0;
    let skippedSidecar = 0;
    let skippedCollision = 0;
    // We have candidates, so the refs dir will be needed; mkdir is idempotent.
    await mkdir(refsDir, { recursive: true });

    for (const filename of candidates) {
      // A staged input upload never has a sidecar — a same-named file WITH a
      // sidecar is a real gallery entry the user imported; leave it alone.
      if (await hasSidecar(imagesDir, filename)) {
        skippedSidecar += 1;
        continue;
      }
      const dest = join(refsDir, filename);
      if (await fileExists(dest)) {
        // UUID collision is effectively impossible; never clobber the existing
        // refs file — leave the gallery copy in place and surface it.
        skippedCollision += 1;
        console.log(`🖼️ migration 085: ${filename} already exists in image-refs — left in gallery dir`);
        continue;
      }
      await rename(join(imagesDir, filename), dest);
      moved += 1;
    }

    console.log(
      `🖼️ migration 085: moved ${moved} staged-upload image(s) out of the gallery into image-refs` +
        (skippedSidecar ? `, kept ${skippedSidecar} with sidecars` : '') +
        (skippedCollision ? `, ${skippedCollision} collision(s) left in place` : ''),
    );
    return { ok: true, reason: 'relocated', moved, skippedSidecar, skippedCollision };
  },
};
