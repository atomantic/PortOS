/**
 * Stage a generated Code Animation page for the OS-jailed composition browser.
 * The interactive preview session and the gallery poster capture both run the
 * page from here, so they load the same policy, audio global and three.js
 * vendor files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { PREVIEW_PAGE_CSP } from '../../lib/generatedPreviewSandbox.js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const SCRATCH_DIR = 'music-video-song-renders';

// Any CSP the generated page declares is replaced: the host's policy is the only one.
export function injectPolicy(html, { csp, audioGlobal, audioDataUrl }) {
  const stripped = String(html).replace(/<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, '');
  const audio = audioDataUrl && IDENT.test(String(audioGlobal || ''))
    ? `<script>window[${JSON.stringify(audioGlobal)}] = ${JSON.stringify(audioDataUrl).replace(/</g, '\\u003c')};</script>`
    : '';
  const tags = `<meta http-equiv="Content-Security-Policy" content="${csp}">${audio}`;
  const head = stripped.match(/<head[^>]*>/i);
  if (!head) return `${tags}${stripped}`;
  const at = head.index + head[0].length;
  return `${stripped.slice(0, at)}${tags}${stripped.slice(at)}`;
}

/** `name` must be unique per run; the caller removes `scratchRoot` when done. */
export async function writeComposition(name, html) {
  const scratchRoot = join(PATHS.data, SCRATCH_DIR, name);
  const composition = join(scratchRoot, 'composition');
  await mkdir(composition, { recursive: true });
  await writeFile(join(composition, 'index.html'), html);
  return { scratchRoot, directory: `${SCRATCH_DIR}/${name}/composition`, composition };
}

export async function stageCodeAnimationPage(name, html, { audioGlobal, audioDataUrl } = {}) {
  const { importsThree, injectThreeImportMap, threeStagedFiles } = await import('../codeAnimation/threeVendor.js');
  const three = importsThree(html);
  const page = injectPolicy(three ? injectThreeImportMap(html) : html, { csp: PREVIEW_PAGE_CSP, audioGlobal, audioDataUrl });
  const written = await writeComposition(name, page);
  if (three) {
    for (const file of await threeStagedFiles()) {
      const target = join(written.composition, file.rel);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, file.data);
    }
  }
  return written;
}
