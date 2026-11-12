/**
 * Render one code module (a shot or a layer) on the film's frame grid.
 *
 * The module runs in the composition browser sandbox: no host access and no
 * network. Pixels come back as raw RGBA and are encoded here with fixed
 * settings, so the same song time writes the same file. A resumed preview
 * or final leaves an existing frame in place. A still always rewrites it.
 */
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { filmCodePage } from './codePage.js';
import { blenderScratchDir, blenderSrcDir } from './workspace.js';

const importsThree = (source) => /(?:\bfrom\s*|\bimport\s+)['"]three(?:\/[^'"]*)?['"]/.test(source);

/** Encode one RGBA frame. Preview plates flatten onto black; layers keep alpha. */
async function encodeFilmPixels(rgba, { width, height, alpha }) {
  if (rgba.length !== width * height * 4) throw new Error(`The code frame is ${rgba.length} bytes, not ${width}×${height} pixels`);
  const { default: sharp } = await import('sharp');
  const image = sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } });
  if (!alpha) {
    return image.flatten({ background: '#000000' }).jpeg({
      quality: 90, mozjpeg: false, chromaSubsampling: '4:4:4',
      trellisQuantisation: false, overshootDeringing: false, optimiseCoding: false,
    }).toBuffer();
  }
  return image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

/**
 * Paint `layers` ({ file, place, blend }, declaration order) onto `plateFile`
 * and write `output`. Unders sit under the plate; overs sit on it. `normal`
 * is src-over. The plate is not an input of itself, so `output` may be the plate.
 */
export async function compositeFilmStill(plateFile, layers, output = plateFile) {
  const present = (layers || []).filter((layer) => layer?.file);
  if (!present.length) return;
  const { default: sharp } = await import('sharp');
  const blendOf = (blend) => (blend === 'normal' || !blend ? 'over' : blend);
  const unders = present.filter((layer) => layer.place === 'under');
  const overs = present.filter((layer) => layer.place !== 'under');
  const stack = [
    ...unders.slice(1).map((layer) => ({ input: layer.file, blend: blendOf(layer.blend) })),
    ...(unders.length ? [{ input: plateFile, blend: 'over' }] : []),
    ...overs.map((layer) => ({ input: layer.file, blend: blendOf(layer.blend) })),
  ];
  const tmp = `${output}.part.png`;
  await sharp(unders.length ? unders[0].file : plateFile).composite(stack).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(tmp);
  await rename(tmp, output);
}

async function stageThree(stage) {
  const vendor = await import('../codeAnimation/threeVendor.js').catch(() => null);
  const staged = vendor ? await vendor.threeStagedFiles().catch(() => null) : null;
  if (!staged) throw new Error('three.js is not available to render this shot');
  for (const file of staged) {
    const target = join(stage, ...file.rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
}

/**
 * Write `frames` ({ frame, t, localT, file }) for `entry`. `paths` is that
 * module's src/-relative closure, copied into the sandbox so its imports resolve.
 */
export async function renderFilmCodeFrames({
  owner, jobId, entry, space = 'canvas', song, width, height, alpha = false, paths, frames, signal, onFrame = () => {},
  reuseExisting = true,
}) {
  const stage = blenderScratchDir(owner, `code-${jobId}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const src = blenderSrcDir(owner);
  let wantsThree = space === 'three';
  let page = null;
  try {
    for (const rel of paths || [entry]) {
      if (typeof rel !== 'string' || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Code import leaves the film source: ${rel}`);
      }
      const absolute = join(src, ...rel.split('/'));
      if (!(await lstat(absolute).catch(() => null))?.isFile()) throw new Error(`Missing code module ${rel}`);
      const target = join(stage, ...rel.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(absolute, target);
      if (!wantsThree && importsThree(await readFile(absolute, 'utf8'))) wantsThree = true;
    }
    if (wantsThree) await stageThree(stage);
    await writeFile(join(stage, 'index.html'), filmCodePage({ entry, space, song, width, height, three: wantsThree }));
    const { openComposition } = await import('../htmlComposition/browser.js');
    page = await openComposition(stage, { signal, ownedBrowser: true, isolation: 'legacy', mediaMode: 'code-only' });
    signal?.throwIfAborted();
    // The module import finishes after the document. Wait until it says so; a thrown module lands on `error`.
    const ready = await page.evaluate(`(async () => {
      const start = Date.now();
      while (!(globalThis.portosFilm && globalThis.portosFilm.ready === true)) {
        if (globalThis.portosFilm && globalThis.portosFilm.error) throw new Error(String(globalThis.portosFilm.error));
        if (Date.now() - start > 15000) throw new Error('The code module did not start');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return true;
    })()`);
    if (ready !== true) throw new Error('The code module did not start');
    for (const [index, frame] of frames.entries()) {
      signal?.throwIfAborted();
      const started = Date.now();
      const existing = reuseExisting ? await lstat(frame.file).catch(() => null) : null;
      if (existing?.isFile() && existing.size > 0) {
        onFrame({ frame: frame.frame, index: index + 1, total: frames.length, skipped: true, sec: 0 });
        continue;
      }
      const spec = { frame: frame.frame, t: frame.t, localT: frame.localT, width, height, alpha: alpha === true };
      const encoded = await page.evaluate(`globalThis.portosFilm.frame(${JSON.stringify(spec)})`);
      if (typeof encoded !== 'string' || !encoded) throw new Error(`Shot frame ${frame.frame} returned no pixels`);
      const bytes = await encodeFilmPixels(Buffer.from(encoded, 'base64'), { width, height, alpha: alpha === true });
      await mkdir(dirname(frame.file), { recursive: true });
      await writeFile(frame.file, bytes);
      onFrame({ frame: frame.frame, index: index + 1, total: frames.length, skipped: false, sec: (Date.now() - started) / 1000 });
    }
  } finally {
    if (page) await page.close().catch(() => {});
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
