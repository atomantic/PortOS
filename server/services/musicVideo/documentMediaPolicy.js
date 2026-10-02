/** Import and render admission, before any imported code executes. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from '@babel/parser';
import { assertMusicVideoMedia, musicVideoMediaMode } from '../../lib/musicVideoMediaPolicy.js';
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg', '.ico']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const SOURCE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.md']);
const FONTS = new Set(['.woff', '.woff2', '.ttf', '.otf']);
export async function assertDocumentMediaPolicy(project, files) {
  if (musicVideoMediaMode(project) === 'code-images-video') return;
  for (const file of files) {
    const ext = extname(file.rel).toLowerCase();
    const bytes = file.data || await readFile(file.abs);
    const signature = bytes.subarray(0, 16);
    if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || signature.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      || /^GIF8[79]a/.test(signature.toString('ascii'))
      || signature.toString('ascii', 8, 12) === 'WEBP') assertMusicVideoMedia(project, 'image', 'document asset');
    if (signature.toString('ascii', 4, 8) === 'ftyp' || signature.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) assertMusicVideoMedia(project, 'video', 'document asset');
    if (IMAGES.has(ext)) assertMusicVideoMedia(project, 'image', 'document asset');
    if (VIDEO.has(ext)) assertMusicVideoMedia(project, 'video', 'document asset');
    // Unknown binary assets cannot hide renamed photos or clips in code-only packages.
    if (!/^(?:.*\/)?LICENSE[^/]*$/i.test(file.rel) && !SOURCE.has(ext) && !FONTS.has(ext) && !IMAGES.has(ext)) assertMusicVideoMedia(project, 'video', 'binary document asset');
    if (SOURCE.has(ext)) {
      let source = bytes.toString('utf8');
      if (ext === '.js' || ext === '.mjs') {
        // Inspect executable text and string literals, not inert JSDoc such as Array<Image>.
        const { comments } = parse(source, { sourceType: 'unambiguous' });
        for (const comment of comments.slice().reverse()) source = source.slice(0, comment.start) + ' ' + source.slice(comment.end);
      }
      if (/data\s*:\s*image\/|<(?:img|image)\b|!\[[^\]]*\]\(/i.test(source)) assertMusicVideoMedia(project, 'image', 'embedded document asset');
      if (/data\s*:\s*(?:video|audio)\/|<(?:video|audio)\b/i.test(source)) assertMusicVideoMedia(project, 'video', 'embedded document asset');
    }
  }
}
