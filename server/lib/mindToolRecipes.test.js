import { describe, expect, it } from 'vitest';
import { mindToolRecipeDefinitionSchema, validateMindToolRecipe, resolveMindToolRecipeBinding } from './mindToolRecipes.js';
import { createDefaultPersistentMindCapabilities, mergePersistentMindCapabilities, persistentMindCapabilitiesSchema } from './persistentMindCapabilities.js';

const tool = (name, properties = {}, required = [], output = { type: 'object', additionalProperties: true }) => ({
  name, aliases: [`alias_${name}`], policy: { scopes: ['mind'], sideEffect: 'read' },
  input_schema: { type: 'object', properties, required, additionalProperties: false }, output_schema: output,
});
const catalog = [tool('brain.search', { query: { type: 'string' } }, ['query']), tool('goals.list', { limit: { type: 'integer' } })];
const recipe = () => ({ schemaVersion: 1, name: 'recipe.checkin', purpose: 'Find project notes and goals',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  steps: [{ id: 'search', tool: 'brain.search', arguments: { query: { input: 'query' } } }, { id: 'goals', tool: 'goals.list', arguments: {} }],
  outputs: { notes: { step: 'search', path: ['entries'] }, goals: { step: 'goals', path: [] } },
});

describe('closed, governed recipe definition boundary', () => {
  it('validates the library without claiming static certainty for open tool outputs', () => {
    const result = validateMindToolRecipe(recipe(), catalog);
    expect(result.valid).toBe(true);
    expect(result.runtimeChecks).toContainEqual(expect.objectContaining({ field: 'outputs.notes', message: expect.stringContaining('Open output') }));
  });

  it.each([
    ['arbitrary code', (value) => { value.steps[0].code = 'process.exit()'; }],
    ['dynamic tools', (value) => { value.steps[0].tool = { input: 'query' }; }],
    ['expression binding', (value) => { value.steps[0].arguments.query = { expression: 'query + 1' }; }],
    ['enum with wrong primitive type', (value) => { value.parameters.properties.query.enum = [3]; }],
    ['open parameters', (value) => { value.parameters.additionalProperties = true; }],
    ['nested recipes', (value) => { value.steps[0].tool = 'recipe.other'; }],
    ['forward reference', (value) => { value.steps[0].arguments.query = { step: 'goals', path: ['title'] }; }],
    ['bad literal', (value) => { value.steps[0].arguments.query = { literal: 3 }; }],
    ['unknown input', (value) => { value.steps[0].arguments.query = { input: 'missing' }; }],
    ['unknown argument', (value) => { value.steps[0].arguments.url = { literal: 'https://invalid.example' }; }],
    ['future version', (value) => { value.schemaVersion = 2; }],
    ['duplicate step', (value) => { value.steps[1].id = 'search'; }],
    ['six steps', (value) => { value.steps = Array.from({ length: 6 }, (_, i) => ({ id: `step${i}`, tool: 'goals.list', arguments: {} })); }],
  ])('rejects %s', (_name, change) => {
    const value = recipe(); change(value);
    expect(() => validateMindToolRecipe(value, catalog)).toThrow();
  });

  it('rejects declared output and input type mismatches, writes, wrong scope and name collisions', () => {
    const value = recipe();
    value.steps[1].arguments.limit = { input: 'query' };
    expect(() => validateMindToolRecipe(value, catalog)).toThrow('binding type');
    value.parameters.properties.query = { type: 'object', properties: { tag: { type: 'integer' } }, required: ['tag'], additionalProperties: false };
    expect(() => validateMindToolRecipe(value, [tool('brain.search', { query: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false } }, ['query']), catalog[1]])).toThrow('binding type');
    value.parameters.properties.query = { type: 'string' };
    value.steps[1].arguments = {};
    expect(() => validateMindToolRecipe(value, [catalog[0], { ...catalog[1], policy: { scopes: ['mind'], sideEffect: 'write' } }])).toThrow('read tool');
    expect(() => validateMindToolRecipe(value, [catalog[0], { ...catalog[1], policy: { scopes: ['voice'], sideEffect: 'read' } }])).toThrow('mind scope');
    expect(() => validateMindToolRecipe(value, [...catalog, { name: 'shipped', aliases: [value.name] }])).toThrow('collides');
    expect(() => validateMindToolRecipe(value, [tool('brain.search', { query: { type: 'string' } }, ['query'], { type: 'object', properties: {}, additionalProperties: false }), catalog[1]])).toThrow('output field');
  });

  it('bounds recursive authored data before parsing and forbids prototype traversal', () => {
    const value = recipe();
    let literal = {};
    for (let i = 0; i < 25; i++) literal = { child: literal };
    value.outputs.value = { literal };
    expect(mindToolRecipeDefinitionSchema.safeParse(value).success).toBe(false);
    value.outputs.value = { step: 'search', path: ['constructor'] };
    expect(mindToolRecipeDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it('resolves only own JSON fields and rejects missing open-output bindings without exposing results', () => {
    const results = { search: { entries: [{ title: 'private result' }] } };
    expect(resolveMindToolRecipeBinding({ step: 'search', path: ['entries', '0', 'title'] }, {}, results)).toBe('private result');
    expect(() => resolveMindToolRecipeBinding({ step: 'search', path: ['absent'] }, {}, results, 'outputs.notes')).toThrow('outputs.notes: output binding is missing');
    expect(() => resolveMindToolRecipeBinding({ input: 'query' }, {}, results)).toThrow('input binding is missing');
  });

  it('defaults the definition grant off and preserves it across old capability updates', () => {
    expect(createDefaultPersistentMindCapabilities().manageToolRecipes).toBe(false);
    expect(persistentMindCapabilitiesSchema.safeParse({ schemaVersion: 8, readPortos: true }).success).toBe(true);
    expect(mergePersistentMindCapabilities({ manageToolRecipes: true }, { schemaVersion: 3, readPortos: false })).toMatchObject({ schemaVersion: 9, manageToolRecipes: true, readPortos: false });
  });
});
