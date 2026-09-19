/**
 * The provider-reference boundary (#7564): every SELECTION field accepts a
 * preset id or a composite; every PRESET-ONLY surface (the active provider, a
 * record's fallback, an app's task-type pin) refuses a composite by naming the
 * rule; and the two settings slices behind composition validate their shape.
 */
import { describe, expect, it } from 'vitest';
import { presetProviderIdSchema, providerRefFieldSchema, providerRefSchema } from './zodCompat.js';
import {
  appUpdateSchema,
  providerSchema as hostProviderSchema,
  credentialBootstrapsSettingsSchema,
  featureProviderConfigSchema,
  harnessSettingsSchema,
  llmSchema,
  runSchema,
} from './validation.js';
import { createCosTaskSchema, createTaskTemplateSchema, updateTaskTemplateSchema } from './cosValidation.js';
import { providerActiveSchema, providerCreateSchema, providerSchema, runSchema as toolkitRunSchema } from './aiToolkit/validation.js';

const ACCEPTED = ['claude-code', 'pi.tui@nvidia-nim-free', 'claude.cli@anthropic+corp-auth', 'direct.api@ollama'];
const REJECTED = ['pi.tui@Nvidia', 'pi.tui@', 'pi.gui@x', 'direct.api@ollama+corp-auth', '__proto__'];

describe('providerRefSchema', () => {
  it.each(ACCEPTED)('accepts %s', (id) => {
    expect(providerRefSchema.safeParse(id).success).toBe(true);
  });

  it.each(REJECTED)('rejects %s with the grammar named', (id) => {
    const result = providerRefSchema.safeParse(id);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/preset id|composite/);
  });

  it('admits the empty picker sentinel only through the field form', () => {
    expect(providerRefSchema.safeParse('').success).toBe(false);
    expect(providerRefFieldSchema.safeParse('').success).toBe(true);
    expect(providerRefFieldSchema.safeParse('pi.gui@x').success).toBe(false);
  });
});

describe('selection validators take either grammar', () => {
  it.each(ACCEPTED)('%s is a valid selection everywhere a provider is picked', (id) => {
    expect(createCosTaskSchema.safeParse({ description: 'Ship the thing', provider: id }).success).toBe(true);
    expect(createTaskTemplateSchema.safeParse({ name: 'Template', description: 'Ship', provider: id }).success).toBe(true);
    expect(updateTaskTemplateSchema.safeParse({ provider: id }).success).toBe(true);
    expect(featureProviderConfigSchema.safeParse({ providerId: id }).success).toBe(true);
    expect(llmSchema.safeParse({ provider: id }).success).toBe(true);
    expect(runSchema.safeParse({ type: 'ai', providerId: id, workspaceId: 'ws' }).success).toBe(true);
    expect(toolkitRunSchema.safeParse({ providerId: id, prompt: 'hi' }).success).toBe(true);
  });

  it('refuses a malformed reference at the same fields', () => {
    expect(createCosTaskSchema.safeParse({ description: 'Ship', provider: 'pi.gui@x' }).success).toBe(false);
    expect(featureProviderConfigSchema.safeParse({ providerId: 'pi.tui@' }).success).toBe(false);
    expect(toolkitRunSchema.safeParse({ providerId: 'direct.api@ollama+corp-auth', prompt: 'hi' }).success).toBe(false);
  });
});

describe('preset-only surfaces refuse a composite and name the rule', () => {
  const message = (result) => result.error.issues.map((issue) => issue.message).join('\n');

  it('PUT /api/providers/active', () => {
    expect(providerActiveSchema.safeParse({ id: 'claude-code' }).success).toBe(true);
    const result = providerActiveSchema.safeParse({ id: 'pi.tui@nvidia-nim' });
    expect(result.success).toBe(false);
    expect(message(result)).toMatch(/preset provider id/);
  });

  it("a record's fallbackProvider", () => {
    const base = { name: 'Claude', type: 'cli' };
    expect(providerSchema.safeParse({ ...base, fallbackProvider: 'codex' }).success).toBe(true);
    expect(providerSchema.safeParse({ ...base, fallbackProvider: null }).success).toBe(true);
    const result = providerSchema.safeParse({ ...base, fallbackProvider: 'pi.tui@nvidia-nim' });
    expect(result.success).toBe(false);
    expect(message(result)).toMatch(/preset provider id/);
    // '' is the picker's "None (use system default)" option, and ProviderForm
    // spreads the whole form into the body — so tightening this field to the
    // preset grammar must not 400 every provider saved without a fallback.
    expect(providerSchema.safeParse({ ...base, fallbackProvider: '' }).success).toBe(true);
    expect(providerCreateSchema.safeParse({ ...base, fallbackProvider: '' }).success).toBe(true);
  });

  it("an app's taskTypeOverrides pin", () => {
    const app = (providerId) => ({ taskTypeOverrides: { 'code-review': { providerId } } });
    expect(appUpdateSchema.safeParse(app('claude-code')).success).toBe(true);
    expect(appUpdateSchema.safeParse(app(null)).success).toBe(true);
    const result = appUpdateSchema.safeParse(app('pi.tui@nvidia-nim'));
    expect(result.success).toBe(false);
    expect(message(result)).toMatch(/preset provider id/);
    expect(presetProviderIdSchema.safeParse('direct.api@ollama').success).toBe(false);
  });
});

describe('the settings slices behind composition', () => {
  it('harnesses: only registry ids, only a boolean, any subset', () => {
    expect(harnessSettingsSchema.safeParse({ pi: { enabled: false } }).success).toBe(true);
    expect(harnessSettingsSchema.safeParse({}).success).toBe(true);
    expect(harnessSettingsSchema.safeParse({ gui: { enabled: false } }).success).toBe(false);
    expect(harnessSettingsSchema.safeParse({ pi: { enabled: 'no' } }).success).toBe(false);
    expect(harnessSettingsSchema.safeParse({ pi: { enabled: true, extra: 1 } }).success).toBe(false);
  });

  it('preserves environment argv in both provider schemas and rejects malformed commands', () => {
    const bootstrap = { command: 'token-cli', envCommand: ['token-cli', 'print-env', 'account with spaces'] };
    for (const schema of [hostProviderSchema, providerSchema]) {
      expect(schema.partial().parse({ credentialBootstrap: bootstrap }).credentialBootstrap).toEqual(bootstrap);
      for (const envCommand of [[], '', [''], [5]]) {
        expect(schema.partial().safeParse({ credentialBootstrap: { ...bootstrap, envCommand } }).success).toBe(false);
      }
    }
  });

  it('credentialBootstraps: slug-keyed apps with the inline bootstrap limits and a harness-keyed name map', () => {
    const app = { label: 'Corp auth', command: 'corp-auth', envCommand: ['corp-auth', 'env'], args: ['run'], argsSeparator: '--', harnessNames: { claude: 'claude-code' } };
    expect(credentialBootstrapsSettingsSchema.safeParse({ 'corp-auth': app }).success).toBe(true);
    expect(credentialBootstrapsSettingsSchema.safeParse({ 'Corp Auth': app }).success).toBe(false);
    expect(credentialBootstrapsSettingsSchema.safeParse({ 'corp-auth': { ...app, command: '' } }).success).toBe(false);
    expect(credentialBootstrapsSettingsSchema.safeParse({ 'corp-auth': { ...app, harnessNames: { gui: 'x' } } }).success).toBe(false);
    expect(credentialBootstrapsSettingsSchema.safeParse({ 'corp-auth': { ...app, secret: 'x' } }).success).toBe(false);
  });
});
