import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateRequest } from './validateRequest.js';
import * as validation from './validation.js';
import * as agentValidation from './agent/agentValidation.js';
import * as cosValidation from './cos/cosValidation.js';
import * as mediaValidation from './mediaValidation.js';
import * as pipelineValidation from './pipelineValidation.js';
import * as spriteValidation from './spriteValidation.js';
import * as sharedSchemas from './sharedSchemas.js';
import * as federatedMediaValidation from './federatedMediaValidation.js';
import * as githubValidation from './githubValidation.js';
import * as insightsValidation from './insightsValidation.js';

it('exposes insights schemas only through their declaring module', () => {
  const names = Object.keys(insightsValidation);
  expect(names.sort()).toEqual([
    'insightRefreshSchema', 'scorecardComputeSchema', 'scorecardRulesSchema', 'scorecardSettingsSchema',
  ]);
  for (const name of names) expect(validation).not.toHaveProperty(name);
});

describe('validation.js shared-schema exports and domain-file independence', () => {
  it('federated-media image primitives retain their shared identities', () => {
    for (const key of ['imageEdgeSchema', 'refineImagePixelCap', 'PIXEL_CAP_MESSAGE']) {
      expect(validation[key]).toBe(sharedSchemas[key]);
    }
  });

  it('cross-cutting primitives stayed in validation.js', () => {
    expect(typeof validation.validate).toBe('function');
    expect(typeof validation.parsePagination).toBe('function');
    expect(typeof validation.optionalBooleanMap).toBe('function');
    expect(typeof validation.isSafeRecordId).toBe('function');
    expect(validation.llmSchema).toBeDefined();
    expect(typeof validation.emptyToUndefined).toBe('function');
  });

  it('#3873: the sprite split kept its shared helpers reachable and its schemas usable', () => {
    // The cross-domain fragments the sprite block depends on live in the leaf
    // sharedSchemas.js; validation.js still exports the SAME objects, and the
    // sprite schemas parse through their declaring module.
    for (const key of ['grokVideoDurationSchema', 'cloudModelIdString', 'recordRenderPinFields', 'isSafeSubdirFilter']) {
      expect(validation[key], `validation.js export of '${key}'`).toBe(sharedSchemas[key]);
    }
    expect(() => validateRequest(spriteValidation.spriteCreateSchema, {
      name: 'Example Sprite', imageMode: '', imageModelId: '',
    })).not.toThrow();
    expect(() => validateRequest(spriteValidation.spriteWalkTrimSchema, {
      runId: 'run-3', enabledColumns: [0, 1, 2],
    })).not.toThrow();
    // The `recordRenderPinFields` spread must still be live inside the moved
    // schemas — a bad model id is a rejection, not a stripped field.
    expect(spriteValidation.spriteCreateSchema.safeParse({
      name: 'Example Sprite', imageModelId: '../etc/passwd',
    }).success).toBe(false);
  });

  it('domain files do NOT import back from validation.js (cycle guard)', () => {
    const domainFiles = ['agent/agentValidation.js', 'cos/cosValidation.js', 'mediaValidation.js', 'pipelineValidation.js',
      'spriteValidation.js', 'githubValidation.js', 'federatedMediaValidation.js'];
    for (const file of domainFiles) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${file} must not import validation.js`).not.toMatch(/from\s*['"](?:\.\.?\/)+validation\.js['"]/);
    }
    for (const mod of [agentValidation, cosValidation, mediaValidation, pipelineValidation, spriteValidation, githubValidation, federatedMediaValidation]) {
      expect(mod.parsePagination).toBeUndefined();
    }
  });
});
