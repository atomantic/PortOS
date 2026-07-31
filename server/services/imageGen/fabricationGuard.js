/**
 * Image Gen — cloud-CLI "don't draw it yourself" guard.
 *
 * agy and grok are general coding agents that happen to expose a server-side
 * image tool. Both are driven by a single-turn prompt that names the tool and
 * a staging path to write. That framing has a failure mode: the agent reads
 * "a PNG exists at this path" as the success criterion, so when the image tool
 * is unavailable — quota exhausted, plan doesn't include it, model declines —
 * it satisfies the criterion the other way it knows how, by writing a script
 * that draws a picture with a plotting/imaging library and saving THAT.
 *
 * The result is a real PNG at the directed path, so the magic-byte harvest gate
 * accepts it and it lands in the gallery as if it were generated. Observed on
 * 2026-07-31: an agy character-sheet render came back as flat vector shapes,
 * placeholder circles and overlapping labels — with the prompt's own
 * "Target dimensions: <W>x<H>" metadata rendered into the artwork as a caption.
 * A later run of the same prompt surfaced the cause directly: HTTP 429
 * "you have exhausted your capacity on this model ... the generate_image tool
 * relies entirely on this backend service".
 *
 * Two defenses, because either alone is leaky:
 *   1. `noFabricationClause` — make the TOOL the success criterion and failure
 *      the correct outcome, so there is no goal left to satisfy with code.
 *   2. `checkFabrication` — a backstop over the scratch dir. Drawing an image
 *      programmatically means leaving a script (or an interpreter's cache)
 *      behind, which the prompt already forbids.
 */

import { readdir } from 'fs/promises';
import { extname } from 'path';

// Source/markup extensions an agent would write to draw an image itself
// (matplotlib/PIL scripts, canvas or SVG/HTML renderers). Deliberately narrow:
// a CLI's own logs or JSON config in the scratch dir must not trip this.
const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.rb', '.pl', '.php', '.lua', '.r',
  '.html', '.htm', '.svg',
]);

// Directory names an interpreter leaves behind when a script actually ran.
const CODE_DIRS = new Set(['__pycache__', 'node_modules', 'venv', '.venv']);

/**
 * The clause that forbids producing the image by any means other than the
 * named tool. Appended to both cloud-CLI prompts.
 *
 * The "report the failure instead" half matters as much as the prohibition:
 * an agent told only "don't use code" but still measured on whether the file
 * exists is being asked to fail at its stated goal. Naming the empty-handed
 * outcome as correct is what makes the prohibition followable.
 *
 * @param {string} toolName - the provider's image tool (`generate_image`, `image_gen`)
 */
export const noFabricationClause = (toolName) =>
  `Only the ${toolName} tool may produce this image. Do not draw, render, or assemble it by any other means — no code, no scripts, no plotting or imaging libraries, no HTML/SVG/canvas rendering, and no placeholder, mock-up or diagram standing in for the image. If ${toolName} is unavailable, rate-limited, refuses, or errors, write nothing at that path and report what went wrong. Reporting the failure is the correct outcome; an image produced any other way is a failed run.`;

/**
 * Scan a finished scratch directory for evidence the agent generated the image
 * with code instead of the image tool, and return the error to fail the render
 * with — or `null` when the run looks clean.
 *
 * Only source files and interpreter caches count. Unknown leftovers are
 * ignored: a CLI writing its own session state or logs into its cwd is normal
 * and must not fail an otherwise-good render. The staged output needs no
 * exemption — an image extension is not in `CODE_EXTENSIONS`.
 *
 * @param {string} scratchDir - the throwaway cwd the CLI ran in
 * @param {string} toolName - the image tool that should have produced the file
 * @returns {Promise<string|null>} failure reason, or null if clean
 */
export async function checkFabrication(scratchDir, toolName) {
  // Recursive listing rather than a hand-rolled walk so the rule is the same at
  // every depth — a `scripts/draw.py` or a nested `__pycache__` counts exactly
  // as much as one dropped beside the output.
  //
  // A scan that FAILS is not a scan that found nothing. ENOENT is a real clean
  // answer (the dir is gone), but EACCES/EMFILE/EIO on a directory the harvest
  // just read a file out of means we don't know. This is a backstop, not the
  // primary defense (the prompt clause is), and failing a legitimate render on
  // a filesystem hiccup costs the user an image they already spent quota on —
  // so it passes, but loudly, rather than collapsing into a silent "clean".
  const paths = await readdir(scratchDir, { recursive: true }).catch((err) => {
    if (err?.code !== 'ENOENT') {
      console.error(`⚠️ Fabrication scan failed for ${toolName} (${err?.code || err?.message}) — accepting the render unchecked`);
    }
    return [];
  });
  // Split on BOTH separators rather than `path.sep`: the guard must not depend
  // on which one Node's recursive readdir emits on a given platform. Getting it
  // wrong silently degrades the directory rule to a no-op — a nested
  // `__pycache__/` with no code-extension file in it would go undetected.
  const residue = paths.filter((rel) =>
    rel.split(/[\\/]/).some((segment) => CODE_DIRS.has(segment))
    || CODE_EXTENSIONS.has(extname(rel).toLowerCase()));
  if (!residue.length) return null;
  // This sentence is PortOS's inference, not the provider's words, and it gets
  // appended to the CLI narration that the image-quota classifier reads. Keep
  // it free of that classifier's trigger phrases ("quota exhausted", "429",
  // "rate limit") — otherwise every fabrication rejection self-reports as a
  // provider quota block, and (worse) overwrites a real one recorded earlier.
  // The narration appended after it still carries the genuine 429 when there
  // was one, which is the signal that should decide.
  return `The image was drawn by code, not generated: the agent wrote ${residue.slice(0, 5).join(', ')} in its scratch directory instead of using ${toolName}. That usually means ${toolName} was not available to it and it produced a stand-in picture. The file was discarded.`;
}
