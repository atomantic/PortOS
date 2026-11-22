/**
 * Image Gen — cloud-CLI "don't draw it yourself" guard. agy/grok treat "a PNG exists at
 * the path" as success, so with their image tool unavailable they script a drawing that
 * the harvest gate accepts. `noFabricationClause` makes the tool the success criterion;
 * `checkFabrication` backstops by scanning the scratch dir for leftover scripts.
 */

import { readdir } from 'fs/promises';
import { extname } from 'path';

// Source/markup extensions an agent would write to draw an image; narrow so CLI logs/JSON don't trip.
const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.rb', '.pl', '.php', '.lua', '.r',
  '.html', '.htm', '.svg',
]);

// Directories an interpreter leaves behind when a script ran.
const CODE_DIRS = new Set(['__pycache__', 'node_modules', 'venv', '.venv']);

/**
 * The clause that forbids producing the image by any means other than the named tool
 * (or built-in image subagent when the CLI delegates image generation there).
 * Naming failure as the correct outcome is what makes the prohibition followable.
 * @param {string} toolName - the provider's image tool (`generate_image`, `image_gen`)
 * @param {{ subagent?: string }} [options]
 */
export const noFabricationClause = (toolName, { subagent } = {}) => {
  const producer = subagent
    ? `built-in ${subagent} subagent or ${toolName} tool`
    : `${toolName} tool`;
  const failureCondition = subagent
    ? `both ${subagent} and ${toolName} are unavailable, rate-limited, refuse, or error`
    : `${toolName} is unavailable, rate-limited, refuses, or errors`;
  return `Only the ${producer} may produce this image. Do not draw, render, or assemble it by any other means — no code, no scripts, no plotting or imaging libraries, no HTML/SVG/canvas rendering, and no placeholder, mock-up or diagram standing in for the image. If ${failureCondition}, write nothing at that path and report what went wrong. Reporting the failure is the correct outcome; an image produced any other way is a failed run.`;
};

/**
 * Scan a finished scratch dir for evidence the agent drew the image with code. Only source
 * files and interpreter caches count; CLI logs are ignored.
 * @param {string} scratchDir - the throwaway cwd the CLI ran in
 * @param {string} toolName - the image tool that should have produced the file
 * @returns {Promise<string|null>} failure reason, or null if clean
 */
export async function checkFabrication(scratchDir, toolName) {
  // A failed scan is not a clean scan, but this is only a backstop: fail open (loudly)
  // rather than discard a render the user already spent quota on. ENOENT is a clean answer.
  const paths = await readdir(scratchDir, { recursive: true }).catch((err) => {
    if (err?.code !== 'ENOENT') {
      console.error(`⚠️ Fabrication scan failed for ${toolName} (${err?.code || err?.message}) — accepting the render unchecked`);
    }
    return [];
  });
  // Split on both separators: the directory rule must not depend on which one recursive
  // readdir emits per platform.
  const residue = paths.filter((rel) =>
    rel.split(/[\\/]/).some((segment) => CODE_DIRS.has(segment))
    || CODE_EXTENSIONS.has(extname(rel).toLowerCase()));
  if (!residue.length) return null;
  // Must avoid the image-quota classifier's trigger phrases ("quota exhausted", "429",
  // "rate limit"): this text is appended to CLI narration that classifier reads, and a
  // match would mislabel every fabrication rejection as a provider quota block.
  return `The image was drawn by code, not generated: the agent wrote ${residue.slice(0, 5).join(', ')} in its scratch directory instead of using ${toolName}. That usually means ${toolName} was not available to it and it produced a stand-in picture. The file was discarded.`;
}
