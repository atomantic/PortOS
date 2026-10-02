/**
 * The HTML page a code-rendered music video seeks (#9076).
 *
 * song.json is written beside index.html for the composition renderer and for
 * a later full-song mux (#9075). The same document is inlined: seek() has to
 * be ready at load, and the preview sandbox cannot fetch. Section code runs
 * after fetch/WebSocket are disabled.
 */

import { parseExpression } from '@babel/parser';
import { ServerError } from '../../lib/errorHandler.js';
import { isDeterministicCodeSource } from '../../lib/musicVideoValidation.js';
import { codeRuntimeSource } from './codeFrame.js';

const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// Compile at document construction, never through browser eval. The wrapper
// retains legacy statement-body sources, but cannot escape into page-level code.
function staticSectionFunction(source) {
  if (!isDeterministicCodeSource(source)) throw new ServerError('A section must be deterministic and offline', { status: 422, code: 'NONDETERMINISTIC_SECTION' });
  if (/<\/script|<!--|-->/i.test(source)) throw new ServerError('Escape HTML script delimiters inside section source with JavaScript string escapes', { status: 422, code: 'INVALID_SECTION_SOURCE' });
  const wrapped = source.includes('function render') ? source : `function render(ctx, env) {\n${source}\n}`;
  const literal = `function (ctx, env) {\n${wrapped}\nreturn typeof render === 'function' ? render(ctx, env) : undefined;\n}`;
  let expression;
  try { expression = parseExpression(`(${literal})`, { sourceType: 'script' }); }
  catch { throw new ServerError('A section function has invalid JavaScript', { status: 422, code: 'INVALID_SECTION_SOURCE' }); }
  if (expression.type !== 'FunctionExpression') throw new ServerError('A section must remain inside its render function', { status: 422, code: 'INVALID_SECTION_SOURCE' });
  return literal;
}

/**
 * @param {object} input
 * @param {object} input.song song.json document
 * @param {object} input.palette
 * @param {Record<string, string>} input.sources section id → render function source
 * @param {number} [input.windowStart] song time the page's t=0 corresponds to
 * @param {number} [input.windowDuration] page duration; defaults to the song
 */
export function buildCodeDocument({ song, palette, sources, width, height, fps, windowStart = 0, windowDuration = null }) {
  const durationSec = windowDuration == null ? song.durationSec : windowDuration;
  const functions = [...new Set(Object.values(sources || {}))]
    .map(source => `[${scriptJson(source)}, ${staticSectionFunction(source)}]`).join(',\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #000; overflow: hidden; }
canvas { display: block; width: 100vw; height: 100vh; object-fit: contain; background: #000; }
</style></head><body><canvas id="portos-code" width="${width}" height="${height}"></canvas><script>
${codeRuntimeSource()}
const SONG = ${scriptJson(song)};
const PALETTE = ${scriptJson(palette)};
const SOURCES = ${scriptJson(sources || {})};
const SECTION_FUNCTIONS = new Map([${functions}]);
const WINDOW_START = ${Number(windowStart) || 0};
function disableNetwork() {
  const block = (name) => function blocked() { throw new Error(name + ' is disabled in a code-rendered video'); };
  for (const key of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
    try { Object.defineProperty(globalThis, key, { configurable: true, value: block(key) }); } catch { /* already sealed */ }
  }
}
disableNetwork();
const canvas = document.getElementById('portos-code');
const ctx = canvas.getContext('2d');
globalThis.portosComposition = {
  durationSec: ${durationSec},
  fps: ${fps},
  width: ${width},
  height: ${height},
  song: SONG,
  seek(t) {
    const time = WINDOW_START + (Number(t) || 0);
    drawCodeFrame({ ctx, song: SONG, palette: PALETTE, sources: SOURCES, compile: source => SECTION_FUNCTIONS.get(source), t: time, width: ${width}, height: ${height}, fps: ${fps} });
  }
};
addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'mv-code:seek' || !Number.isFinite(data.t)) return;
  globalThis.portosComposition.seek(data.t);
});
globalThis.portosComposition.seek(0);
try { parent.postMessage({ type: 'mv-code:ready', durationSec: ${durationSec} }, '*'); } catch { /* opened as a file */ }
</script></body></html>`;
  return { html, song, durationSec, fps, width, height, windowStart: Number(windowStart) || 0 };
}

