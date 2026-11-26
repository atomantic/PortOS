/** Assemble the layered engine as a standalone script for shipped documents. */
import { readFile } from 'node:fs/promises';
import { DOCUMENT_PALETTE } from '../../lib/musicVideo/musicVideoDocumentPalette.js';

const template = new URL('./documentTemplates/layered/engine.js', import.meta.url);
const marker = '/* PORTOS_LAYERED_PALETTE */ { paper: style.color }';

export async function readLayeredEngine() {
  const source = await readFile(template, 'utf8');
  if (!source.includes(marker)) throw new Error('Layered engine is missing its palette marker');
  const { ink, paper, dim, faint, accent, ok, alert } = DOCUMENT_PALETTE;
  // Preserve the shipped engine bytes so existing documents still match the preview's pinned digest.
  const palette = `{
    ink: '${ink}', paper: style.color || '${paper}', dim: '${dim}', faint: '${faint}',
    accent: '${accent}', ok: '${ok}', alert: '${alert}',
  }`;
  return Buffer.from(source.replace(marker, () => palette));
}
