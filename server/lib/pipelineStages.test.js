import { describe, expect, it } from 'vitest';
import {
  buildPipelineIntentRe,
  PIPELINE_STAGE_ALIASES,
  PIPELINE_STAGE_IDS,
  PIPELINE_STAGE_LABELS,
  PIPELINE_TAB_STAGE_IDS,
} from './pipelineStages.js';

describe('pipelineStages', () => {
  it('keeps every spoken alias reachable through the derived intent regex', () => {
    const intentRe = buildPipelineIntentRe(PIPELINE_STAGE_ALIASES);
    for (const alias of Object.keys(PIPELINE_STAGE_ALIASES)) {
      expect(`open ${alias}`).toMatch(intentRe);
    }
  });

  it('maps every spoken alias to a visible pipeline tab', () => {
    for (const stageId of Object.values(PIPELINE_STAGE_ALIASES)) {
      expect(PIPELINE_TAB_STAGE_IDS).toContain(stageId);
    }
  });

  it('labels every visible tab and limits UI-only ids to Nouns', () => {
    for (const stageId of PIPELINE_TAB_STAGE_IDS) {
      expect(PIPELINE_STAGE_LABELS[stageId]).toEqual(expect.any(String));
      expect(PIPELINE_STAGE_IDS.includes(stageId) || stageId === 'nouns').toBe(true);
    }
  });

  it('accepts visible labels through the spoken alias table', () => {
    for (const stageId of PIPELINE_TAB_STAGE_IDS) {
      expect(PIPELINE_STAGE_ALIASES[PIPELINE_STAGE_LABELS[stageId].toLowerCase()]).toBe(stageId);
    }
  });

  it('matches multi-word aliases in each supported navigation phrase', () => {
    const intentRe = buildPipelineIntentRe(PIPELINE_STAGE_ALIASES);
    expect('open voice over').toMatch(intentRe);
    expect('go to the comic script stage').toMatch(intentRe);
    expect('back to episode video').toMatch(intentRe);
  });
});
