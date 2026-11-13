// Replace the example shots, not the clock: seek must finish drawing before it resolves.
import { makeCel } from './kit/cel.js';
import { makeStage } from './kit/stage.js';
import { makeSong } from './kit/song.js';
import { makeGardenShot } from './shots/garden.js';
import { makeCloseShot } from './shots/close.js';

const mv = globalThis.PORTOS_MV;
const width = mv?.render?.width || 1920;
const height = mv?.render?.height || 1080;
const fps = mv?.render?.fps || 24;
const durationSec = mv?.render?.durationSec || mv?.song?.durationSec || 16;
const canvas = document.getElementById('stage');
canvas.width = width; canvas.height = height;
const out = canvas.getContext('2d');
const stage = makeStage(width, height);
const cel = makeCel(width, height);
// Set anchorSec here to count bar 1 from a pickup or a selected downbeat.
const song = makeSong(mv);
const garden = makeGardenShot({ stage, song, cel, fps });
const close = makeCloseShot({ stage, song, cel, fps, garden });

function draw(t) {
  const bar = Math.floor(song.barAt(t));
  const inPhrase = ((bar - 1) % 8 + 8) % 8;
  if (inPhrase >= 6) {
    const first = bar - (inPhrase - 6);
    close.draw(out, t, song.barTime(first), song.barTime(first + 2));
  } else garden.draw(out, t);
}

globalThis.portosComposition = {
  durationSec, fps, width, height,
  async seek(t) { draw(t); },
};
draw(0);
