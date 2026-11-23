import { copyFile, mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { readLyricOverlayDocumentFiles } from './compositionDocument.js';
import { lyricOverlayDocumentData } from './lyricPlaythrough.js';

/**
 * Stage the storyboard animatic's lyric overlay page (documentTemplates/lyricOverlay,
 * with the shared lyricType.js and its faces) in `dir`, drawing `project`'s lyrics
 * at the render's frame, so a composed render's words match the animatic's.
 */
export async function stageLyricOverlay(dir, project, { width, height, fps, durationSec }) {
  for (const [rel, file] of await readLyricOverlayDocumentFiles()) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await copyFile(file.abs, join(dir, rel));
  }
  const data = lyricOverlayDocumentData(project, { width, height, fps, durationSec });
  await writeFile(join(dir, 'portos-mv.js'), `window.PORTOS_MV = ${JSON.stringify(data).replace(/</g, '\\u003c')};\n`);
}

