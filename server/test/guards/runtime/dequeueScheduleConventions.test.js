/**
 * #5644 — every dequeue/immediate-spawn in cos.js is scheduled from a timer or
 * setImmediate, outside the request lifecycle, where a rejection has nowhere to
 * bubble: it escapes as an unhandled rejection, which setupProcessErrorHandlers
 * classifies `critical` and broadcasts to every browser as
 * `system:critical-error`, and the open agent slot stays empty until an
 * unrelated event fires another cycle. No runtime seam catches a contributor
 * re-adding a bare `setImmediate(() => dequeueNextTask())`, so scan the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const COS_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../services/cos/cos.js'), 'utf-8');

describe('cos.js dequeue scheduling', () => {
  it('never floats a dequeueNextTask / tryImmediateSpawn schedule without a .catch', () => {
    expect(
      COS_SRC,
      'schedule the dequeue through scheduleDequeue() so the rejection is caught'
    ).not.toMatch(/set(?:Immediate|Timeout)\(\(\) => dequeueNextTask\(/);

    const lineStartOf = (idx) => COS_SRC.lastIndexOf('\n', idx) + 1;
    const unguarded = [];
    for (const name of ['dequeueNextTask', 'tryImmediateSpawn']) {
      const re = new RegExp(`${name}\\(`, 'g');
      let match;
      while ((match = re.exec(COS_SRC)) !== null) {
        const line = COS_SRC.slice(lineStartOf(match.index), COS_SRC.indexOf('\n', match.index));
        if (/^\s*(?:\/\/|\*)/.test(line)) continue; // prose mention in a comment
        const before = COS_SRC.slice(Math.max(0, match.index - 40), match.index);
        if (/function\s+$/.test(before)) continue; // the declaration itself
        if (/await\s+$/.test(before)) continue; // awaited by an async caller
        // Otherwise the promise floats, so a `.catch(` must follow inside the
        // same statement (before the terminating `;`).
        const tail = COS_SRC.slice(match.index, match.index + 400);
        if (/^[^;]*\.catch\(/s.test(tail)) continue;
        unguarded.push(line.trim());
      }
    }
    expect(unguarded, 'floated scheduler promises must be .catch-guarded').toEqual([]);
  });
});
