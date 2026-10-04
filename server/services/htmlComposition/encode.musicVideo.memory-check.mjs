// Measures encodeComposition's retained heap across a 600s/12fps job.
// Run with `node --expose-gc`. Kept out of vitest so it cannot tear down the
// suite's shared temp root.
import { EventEmitter } from 'node:events';
import { encodeComposition } from './encode.js';

if (typeof global.gc !== 'function') {
  console.error('❌ forced GC is required');
  process.exit(2);
}

const FRAME = Buffer.alloc(4 * 1024, 7).toString('base64');
const page = {
  check() {},
  async evaluate() {},
  async send(method) {
    if (method === 'Emulation.setDeviceMetricsOverride') return {};
    return { data: FRAME };
  },
};

let bytes = 0;
const spawnProcess = () => {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = (buf, cb) => { bytes += buf.length; cb?.(); return true; };
  proc.stdin.end = () => { proc.emit('close', 0); };
  proc.kill = () => {};
  return proc;
};

const samples = [];
await encodeComposition(page, { fps: 12, durationSec: 600, width: 1280, height: 720, motionBlur: 1 }, '/tmp/long.mp4', {
  spawnProcess,
  locateFfmpeg: async () => '/usr/bin/ffmpeg',
  tagFilter: async () => 'format=yuv420p',
  onProgress: (_fraction, detail) => {
    if (detail.frame === 400 || detail.frame === 7200) {
      global.gc();
      samples.push(process.memoryUsage().heapUsed);
    }
  },
});

const delta = samples.length === 2 ? samples[1] - samples[0] : Number.POSITIVE_INFINITY;
if (!(bytes > 0) || samples.length !== 2 || delta >= 12 * 1024 * 1024) {
  console.error(`❌ retained-heap delta=${delta} bytes=${bytes} samples=${samples.length}`);
  process.exit(1);
}
console.log(`✅ retained-heap delta=${delta}`);
