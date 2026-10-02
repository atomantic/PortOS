/** Import and render admission, before any imported code executes. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { assertMusicVideoMedia, musicVideoMediaMode } from '../../lib/musicVideoMediaPolicy.js';
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg', '.ico']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const SOURCE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.md']);
const FONTS = new Set(['.woff', '.woff2', '.ttf', '.otf']);
export async function assertDocumentMediaPolicy(project, files) {
  if (musicVideoMediaMode(project) === 'code-images-video') return;
  for (const file of files) {
    const ext = extname(file.rel).toLowerCase();
    if (IMAGES.has(ext)) assertMusicVideoMedia(project, 'image', 'document asset');
    if (VIDEO.has(ext)) assertMusicVideoMedia(project, 'video', 'document asset');
    // Unknown binary assets cannot hide renamed photos or clips in code-only packages.
    if (!/^(?:.*\/)?LICENSE[^/]*$/i.test(file.rel) && !SOURCE.has(ext) && !FONTS.has(ext) && !IMAGES.has(ext)) assertMusicVideoMedia(project, 'video', 'binary document asset');
    if (SOURCE.has(ext)) {
      const source = (file.data || await readFile(file.abs)).toString('utf8');
      if (/data\s*:\s*image\/|<img\b|!\[[^\]]*\]\(/i.test(source)) assertMusicVideoMedia(project, 'image', 'embedded document asset');
      if (/data\s*:\s*(?:video|audio)\/|<(?:video|audio)\b/i.test(source)) assertMusicVideoMedia(project, 'video', 'embedded document asset');
    }
  }
}
