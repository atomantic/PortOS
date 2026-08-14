import { describe, expect, it } from 'vitest';

import { applyImageStrengthBackfill } from './268-cd-evaluate-image-strength-crlf.js';

// The pre-002 template, reduced to the two regions the backfill touches.
const PRE_UPDATE_LF = [
  '## Scene to evaluate',
  '',
  '- Intent: {{scene.intent}}',
  '- Strategy: {{scene.strategy}}',
  '- Retry count: {{scene.retryCount}} (max 3)',
  '',
  '**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation.',
  '',
].join('\n');

const toCrlf = (text) => text.replace(/\n/g, '\r\n');

describe('migration 268 — CRLF-tolerant cd-evaluate imageStrength backfill', () => {
  it('inserts both pieces into an LF template (what 002 already handled)', () => {
    const out = applyImageStrengthBackfill(PRE_UPDATE_LF);
    expect(out).toContain('{{#scene.hasImageStrength}}- Image strength: {{scene.imageStrength}}');
    expect(out).toContain('{{^scene.hasImageStrength}}- Image strength: default');
    expect(out).toContain('adjust `imageStrength`');
  });

  // The bug: 002's anchors end in a bare \n, so on a CRLF template none of them
  // match, it writes nothing, and the runner still records it as applied — the
  // install is stuck a template version behind with no path back.
  it('inserts both pieces into a CRLF template', () => {
    const out = applyImageStrengthBackfill(toCrlf(PRE_UPDATE_LF));
    expect(out).toContain('{{#scene.hasImageStrength}}- Image strength: {{scene.imageStrength}}');
    expect(out).toContain('adjust `imageStrength`');
  });

  it('writes a CRLF template back as CRLF, and an LF one as LF', () => {
    const crlfOut = applyImageStrengthBackfill(toCrlf(PRE_UPDATE_LF));
    expect(crlfOut.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(crlfOut)).toBe(false); // no bare LF left behind

    const lfOut = applyImageStrengthBackfill(PRE_UPDATE_LF);
    expect(lfOut.includes('\r')).toBe(false);
  });

  it('is a no-op once the block is present, in either newline style', () => {
    const applied = applyImageStrengthBackfill(PRE_UPDATE_LF);
    expect(applyImageStrengthBackfill(applied)).toBeNull();
    expect(applyImageStrengthBackfill(toCrlf(applied))).toBeNull();
  });

  it('leaves a hand-customized template alone rather than guessing', () => {
    const customized = PRE_UPDATE_LF
      .replace('- Strategy: {{scene.strategy}}', '- Approach: {{scene.strategy}}')
      .replace('**If the render misses the mark', '**When the render misses the mark');
    const logged = [];
    expect(applyImageStrengthBackfill(customized, { log: (m) => logged.push(m) })).toBeNull();
    expect(logged).toHaveLength(2);
    expect(logged.every((m) => m.includes('Hand-merge from data.reference/'))).toBe(true);
  });
});
