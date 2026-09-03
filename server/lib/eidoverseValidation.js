// =============================================================================
// EIDOVERSE WORLD PROJECTION
// =============================================================================
// Split out of validation.js (#5698), which re-exports this module so every
// existing consumer's import specifier keeps working.
//
// Cycle rule: this module must import ONLY zod. Importing back from
// validation.js would TDZ — ESM hoists its `export * from` line, so this file
// evaluates before validation.js's body runs.

import { z } from 'zod';

// Eidoverse identities are currently name-based when no archipelago session is
// present. Keep the PortOS-side contract deliberately conservative: names and
// ids are durable world keys, while display metadata stays in the private
// world log and never becomes a federation payload.
const eidoverseWorldNameSchema = z.string().trim().min(1).max(64).regex(
  /^[a-z0-9_-]+$/i,
  'must contain only letters, numbers, hyphens, and underscores',
);
const eidoverseIdentitySchema = z.string().trim().min(1).max(64).regex(
  /^[^\u0000-\u001f\u007f]+$/,
  'must not contain control characters',
);
const eidoverseVector3Schema = z.array(z.number().finite()).length(3);
const eidoverseAssetPathSchema = z.string().trim().min(1).max(512).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !normalized.includes('..')
    && (/^eidoverse\//i.test(normalized) || /^store\//i.test(normalized));
}, 'must be a relative Eidoverse library or store asset path');
const eidoverseModelAssetOverrideSchema = eidoverseAssetPathSchema.refine((value) => (
  (value.startsWith('eidoverse/assets/models/') && value.toLowerCase().endsWith('.glb'))
  || /^store\/[A-Za-z0-9._/-]+$/.test(value)
), 'must be a model-library GLB or an explicit local store asset');

// These are the resource lanes that the deterministic PortOS projection may
// materialize. Keep the list explicit: a recipe must opt into known data
// families rather than accepting an arbitrary source key that the service
// would not know how to sanitize.
export const EIDOVERSE_PROJECTION_SOURCE_KEYS = Object.freeze([
  'apps',
  'agents',
  'tasks',
  'features',
  'peers',
  'health',
  'productivity',
  'activity',
  'goals',
  'memory',
  'storage',
  'jira',
  'operations',
]);

const eidoverseProjectionIncludesSchema = z.object({
  apps: z.boolean(),
  agents: z.boolean(),
  tasks: z.boolean(),
  features: z.boolean(),
  peers: z.boolean(),
  health: z.boolean(),
  productivity: z.boolean(),
  activity: z.boolean(),
  goals: z.boolean(),
  memory: z.boolean(),
  storage: z.boolean(),
  jira: z.boolean(),
  operations: z.boolean(),
}).strict();

const eidoverseProjectionAssetsSchema = z.object({
  app: eidoverseAssetPathSchema,
  agent: eidoverseAssetPathSchema,
  task: eidoverseAssetPathSchema,
  feature: eidoverseAssetPathSchema,
  peer: eidoverseAssetPathSchema,
  health: eidoverseAssetPathSchema,
  productivity: eidoverseAssetPathSchema,
  activity: eidoverseAssetPathSchema,
  goal: eidoverseAssetPathSchema,
  memory: eidoverseAssetPathSchema,
  storage: eidoverseAssetPathSchema,
  jira: eidoverseAssetPathSchema,
  operations: eidoverseAssetPathSchema,
}).strict();

const eidoverseProjectionTerrainLayerSchema = z.object({
  color: z.string().trim().min(1).max(32),
  repeat: z.number().finite().positive().max(128),
}).strict();

const eidoverseProjectionTerrainSchema = z.object({
  seed: z.string().trim().min(1).max(64),
  size: z.number().finite().positive().max(512),
  segments: z.number().int().min(2).max(512),
  amplitude: z.number().finite().min(0).max(100),
  flatRadius: z.number().finite().min(0).max(256),
  layers: z.array(eidoverseProjectionTerrainLayerSchema).max(8),
}).strict();

const eidoverseProjectionRecipeV1Schema = z.object({
  version: z.literal(1),
  includes: eidoverseProjectionIncludesSchema,
  limits: z.object({
    apps: z.number().int().min(0).max(100),
    agents: z.number().int().min(0).max(100),
    tasks: z.number().int().min(0).max(100),
    features: z.number().int().min(0).max(100),
    peers: z.number().int().min(0).max(100),
    health: z.number().int().min(0).max(100),
    productivity: z.number().int().min(0).max(100),
    activity: z.number().int().min(0).max(100),
    goals: z.number().int().min(0).max(100),
    memory: z.number().int().min(0).max(100),
    storage: z.number().int().min(0).max(100),
    jira: z.number().int().min(0).max(100),
    operations: z.number().int().min(0).max(100),
  }).strict(),
  layout: z.object({
    origin: eidoverseVector3Schema,
    spacing: z.number().finite().min(2).max(100),
    laneGap: z.number().finite().min(2).max(100),
    columns: z.number().int().min(1).max(32),
  }).strict(),
  scale: z.object({
    app: z.number().finite().positive().max(20),
    agent: z.number().finite().positive().max(20),
    task: z.number().finite().positive().max(20),
    feature: z.number().finite().positive().max(20),
    peer: z.number().finite().positive().max(20),
    health: z.number().finite().positive().max(20),
    productivity: z.number().finite().positive().max(20),
    activity: z.number().finite().positive().max(20),
    goal: z.number().finite().positive().max(20),
    memory: z.number().finite().positive().max(20),
    storage: z.number().finite().positive().max(20),
    jira: z.number().finite().positive().max(20),
    operations: z.number().finite().positive().max(20),
  }).strict(),
  assets: eidoverseProjectionAssetsSchema,
  terrain: eidoverseProjectionTerrainSchema,
}).strict();

const eidoverseProjectionLimitsSchema = z.object(Object.fromEntries(
  EIDOVERSE_PROJECTION_SOURCE_KEYS.map((key) => [key, z.number().int().min(0).max(100)]),
)).strict();

const eidoverseProjectionScaleSchema = z.object({
  app: z.number().finite().positive().max(20),
  agent: z.number().finite().positive().max(20),
  task: z.number().finite().positive().max(20),
  feature: z.number().finite().positive().max(20),
  peer: z.number().finite().positive().max(20),
  health: z.number().finite().positive().max(20),
  productivity: z.number().finite().positive().max(20),
  activity: z.number().finite().positive().max(20),
  goal: z.number().finite().positive().max(20),
  memory: z.number().finite().positive().max(20),
  storage: z.number().finite().positive().max(20),
  jira: z.number().finite().positive().max(20),
  operations: z.number().finite().positive().max(20),
}).strict();

const eidoverseDistrictIdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

const eidoverseAssetSlotSchema = z.object({
  preferredPaths: z.array(eidoverseAssetPathSchema).max(8),
  fallbackQueries: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  requiredTokens: z.array(z.string().trim().min(1).max(40)).max(12),
  excludedTokens: z.array(z.string().trim().min(1).max(40)).max(12),
  maxBytes: z.number().int().positive().max(250_000_000),
  format: z.literal('glb'),
  animation: z.enum(['none', 'optional', 'required']),
  sourcePolicy: z.literal('library-only'),
  fallback: eidoverseAssetPathSchema,
}).strict();

const eidoverseAssetSlotsSchema = z.object({
  nexus: eidoverseAssetSlotSchema,
  app: eidoverseAssetSlotSchema,
  agent: eidoverseAssetSlotSchema,
  task: eidoverseAssetSlotSchema,
  goal: eidoverseAssetSlotSchema,
  memory: eidoverseAssetSlotSchema,
  storage: eidoverseAssetSlotSchema,
  peer: eidoverseAssetSlotSchema,
  activity: eidoverseAssetSlotSchema,
  district: eidoverseAssetSlotSchema,
}).strict();

const eidoverseResolvedAssetsSchema = z.record(z.string().trim().min(1).max(40), eidoverseAssetPathSchema)
  .refine((assets) => Object.keys(assets).length <= 32, 'at most 32 asset slots may be configured');

const eidoverseProjectionEnvironmentSchema = z.object({
  terrain: eidoverseProjectionTerrainSchema,
  sky: z.object({
    system: z.literal('skymesh'),
    hours: z.number().finite().min(0).max(24),
    azimuth: z.number().finite().min(0).max(360),
    sun: z.number().finite().min(0).max(2.5),
    ambient: z.number().finite().min(0).max(2.5),
    fill: z.number().finite().min(0).max(2.5),
    exposure: z.number().finite().min(0.3).max(1.8),
    fog: z.number().finite().min(0).max(3),
    clouds: z.enum(['clear', 'cirrus', 'cumulus', 'stratus']),
    weather: z.string().trim().min(1).max(40),
  }).strict(),
  grass: z.object({
    species: z.string().trim().min(1).max(40),
    width: z.number().finite().positive().max(256),
    depth: z.number().finite().positive().max(256),
    center: z.tuple([z.number().finite(), z.number().finite()]),
    height: z.number().finite().positive().max(4),
    color: z.string().trim().min(1).max(40),
    density: z.number().finite().positive().max(2),
  }).strict(),
  lights: z.array(z.object({
    id: z.string().regex(/^portos-design-v2-[A-Za-z0-9_-]{1,47}$/),
    pos: eidoverseVector3Schema,
    color: z.number().int().min(0).max(0xffffff),
    intensity: z.number().finite().positive().max(100),
    range: z.number().finite().positive().max(256),
    keep: z.boolean(),
    day: z.boolean(),
  }).strict()).max(4),
}).strict();

const eidoverseProjectionRecipeV2Schema = z.object({
  version: z.literal(2),
  name: z.string().trim().min(1).max(80),
  maxEntities: z.number().int().min(1).max(48),
  includes: eidoverseProjectionIncludesSchema,
  limits: eidoverseProjectionLimitsSchema,
  scale: eidoverseProjectionScaleSchema,
  districts: z.array(z.object({
    id: eidoverseDistrictIdSchema,
    label: z.string().trim().min(1).max(80),
    direction: z.string().trim().min(1).max(40),
    landmark: z.string().trim().min(1).max(80),
    anchor: eidoverseVector3Schema,
    sources: z.array(z.enum(EIDOVERSE_PROJECTION_SOURCE_KEYS)).min(1).max(8),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  }).strict()).min(1).max(12),
  paths: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    label: z.string().trim().min(1).max(100),
    toDistrictId: eidoverseDistrictIdSchema,
    nodes: z.array(eidoverseVector3Schema).min(1).max(8),
  }).strict()).max(16),
  environment: eidoverseProjectionEnvironmentSchema,
  assetRecipe: z.object({ version: z.literal(2), slots: eidoverseAssetSlotsSchema }).strict(),
  assets: eidoverseResolvedAssetsSchema,
}).strict();

export const eidoverseProjectionRecipeSchema = z.union([
  eidoverseProjectionRecipeV1Schema,
  eidoverseProjectionRecipeV2Schema,
]);

// This is intentionally an opaque, bounded argument bag at the HTTP boundary.
// The PortOS service applies the narrower verb-specific checks immediately
// before sending it to Eidoverse, which keeps this public schema forward-
// compatible with the external world's evolving component vocabulary without
// accepting unbounded payloads.
const eidoverseAugmentArgsSchema = z.record(z.string().max(80), z.unknown()).superRefine((value, ctx) => {
  if (JSON.stringify(value).length > 8192) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'arguments must be at most 8KB' });
  }
});

export const EIDOVERSE_AUGMENT_VERBS = ['spawn', 'place', 'remove', 'comp', 'light', 'terrain', 'grass', 'sky', 'grant'];

export const eidoverseWorldAugmentSchema = z.object({
  operations: z.array(z.object({
    verb: z.enum(EIDOVERSE_AUGMENT_VERBS),
    args: eidoverseAugmentArgsSchema,
  }).strict()).min(1).max(100),
}).strict();

export const eidoverseWorldSaySchema = z.object({
  text: z.string().trim().min(1).max(2000),
}).strict();

export const eidoverseWorldConfigPatchSchema = z.object({
  world: eidoverseWorldNameSchema.optional(),
  humanName: eidoverseIdentitySchema.nullable().optional(),
  humanAvatar: eidoverseAssetPathSchema.nullable().optional(),
  cosId: eidoverseIdentitySchema.optional(),
  cosAvatar: eidoverseAssetPathSchema.nullable().optional(),
  cosEnabled: z.boolean().optional(),
  recipe: eidoverseProjectionRecipeSchema.optional(),
  assetOverrides: z.partialRecord(
    z.enum([
      'nexus', 'app', 'agent', 'task', 'goal', 'memory', 'storage', 'peer', 'activity', 'district',
      // V1 used resource-kind keys. Keep accepting them so an upgraded install
      // can round-trip its preserved custom paths while the V2 semantic slots
      // become the preferred editing surface.
      'feature', 'health', 'productivity', 'jira', 'operations',
    ]),
    eidoverseModelAssetOverrideSchema,
  ).optional(),
  refreshAssets: z.boolean().optional(),
  reset: z.object({
    scope: z.enum(['all', 'assets', 'district']),
    districtId: eidoverseDistrictIdSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.scope === 'district' && !value.districtId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['districtId'], message: 'districtId is required for a district reset' });
    }
  }).optional(),
}).strict();
