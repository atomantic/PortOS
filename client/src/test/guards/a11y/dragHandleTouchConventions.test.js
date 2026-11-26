/**
 * Rule: A JSX element spreading dnd-kit `listeners` must carry `touch-none` in its opening tag (or be in `TOUCH_SENSOR_EXEMPT` with a delayed `TouchSensor`).
 * Fix: Add `touch-none` to the drag handle's `className`.
 * What this guard cannot see:
 *   - Scoped to git-tracked non-test sources (comments masked); only checks JSX elements spreading `listeners` directly.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

const TOUCH_SENSOR_EXEMPT = {
  // Each segment block is the drag source inside the overflow-x lane; touch
  // picks it up on a long press so a swipe still scrolls the lane.
  'src/components/media/VideoTimelineLanes.jsx': 'src/components/media/VideoTimelineTracks.jsx',
};

const LISTENER_SPREAD = /\{\.\.\.(?:[A-Za-z_$][\w$]*\.)?(?:[\w$]*[lL]isteners|dragHandleProps)\}/g;

// The opening tag around `index`: walk back to the `<Tag` at brace depth 0,
// then forward to the `>` that closes it (skipping `=>` inside handlers).
function openingTagAt(source, index) {
  let depth = 0;
  let start = -1;
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') depth--;
    else if (ch === '<' && depth === 0 && /[A-Za-z]/.test(source[i + 1] || '')) { start = i; break; }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0 && source[i - 1] !== '=') return source.slice(start, i + 1);
  }
  return null;
}

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  const out = [];
  for (const match of source.matchAll(LISTENER_SPREAD)) {
    const tag = openingTagAt(source, match.index);
    if (tag && /(?:^|[\s"'`])touch-none(?=[\s"'`]|$)/.test(tag)) continue;
    out.push(`${file}:${lineOf(source, match.index)} — ${match[0]}`);
  }
  return out;
}

describe('dnd-kit drag handle touch conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags a listener spread without touch-none and clears the touch-safe forms', () => {
    const flagged = (markup) => violationsIn(markup, 'probe.jsx').length;
    expect(flagged('<button {...listeners} className="cursor-grab" />')).toBe(1);
    expect(flagged('<button {...drag.listeners} className="cursor-grab" />')).toBe(1);
    expect(flagged('<button className={`px-1 ${on ? "a" : "b"}`} onClick={() => go()} {...bucketDragListeners}>x</button>')).toBe(1);
    expect(flagged('<button {...dragHandleProps} className="cursor-grab" />')).toBe(1);
    expect(flagged('<button {...listeners} className="touch-none cursor-grab" />')).toBe(0);
    expect(flagged('<button className={`touch-none ${x}`} onClick={() => go()} {...attributes} {...listeners} />')).toBe(0);
    // A `touch-none` on a sibling element does not cover this handle.
    expect(flagged('<div className="touch-none"><button {...listeners} /></div>')).toBe(1);
  });

  it('keeps every exempt drag source backed by a TouchSensor', () => {
    for (const host of Object.values(TOUCH_SENSOR_EXEMPT)) {
      expect(readText(join(CLIENT_ROOT, host))).toMatch(/useSensor\(TouchSensor,\s*\{\s*activationConstraint:\s*\{\s*delay:/);
    }
  });

  it('gives every dnd-kit drag handle touch-action: none', () => {
    const violations = files
      .filter((file) => !(file in TOUCH_SENSOR_EXEMPT))
      .flatMap((file) => violationsIn(readText(join(CLIENT_ROOT, file)), file));
    expect(violations).toEqual([]);
  });
});
