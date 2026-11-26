/**
 * Capability-oriented tool registry shared by HTTP, voice adapters, and the
 * Persistent Mind. Raw routes are deliberately not callable through it.
 */

import { z } from 'zod';
import {
  COS_TOOL_OBJECT_OUTPUT_SCHEMA as objectOutputSchema,
  COS_TOOL_SCHEMA_VERSION,
  cosToolCallSchema,
  normalizePortosSemanticToolGrants,
  providerToolName,
} from '../../lib/cos/cosToolContracts.js';
import { zodToOpenApiSchema } from '../../lib/apiContractSchemas.js';
import { canonicalStringify } from '../../lib/objects.js';
import { sha256Text } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { persistentMindChooseNameSchema } from '../../lib/persistent/persistentMindChosenName.js';
import { normalizePersistentMindCapabilities } from '../../lib/persistent/persistentMindCapabilities.js';
import {
  TOOL_ACTIVATION_FAMILIES,
  activatePersistentMindToolActivationFamilies,
  agePersistentMindToolActivation,
  deactivatePersistentMindToolActivationFamilies,
  normalizePersistentMindToolActivation,
  renewPersistentMindToolActivationFamily,
  toolsActivateInputSchema,
  toolsDeactivateInputSchema,
} from '../../lib/persistent/persistentMindToolActivation.js';
import {
  currentAgentAuthority,
  currentMindAuthority,
  executeRecipe,
  executeRecipeManagement,
  readMindRecipeTools,
  readRecipeToolsForScope,
  recipeManagementTools,
  resolveRecipeInvocation,
} from '../mindToolRecipeRuntime.js';
import { scrubEphemeralSecrets, scrubEphemeralSecretsDeep } from '../../lib/secretText.js';
import { loadState, saveState, withStateLock } from './cosState.js';
import { eidoverseAdapterHandlers, eidoverseTools } from './tools/eidoverseTools.js';
import { maintenanceRefreshTool, mindAdapterHandlers, mindTools, reportTools } from './tools/mindTools.js';
import { VOICE_ADAPTERS, voiceAdapterHandlers, voiceTools } from './tools/voiceTools.js';
import {
  artistProfileTool,
  browserVaultTools,
  sandboxTools,
  skillTools,
  userActionsQueryTool,
  workspaceAdapterHandlers,
} from './tools/workspaceTools.js';

export { USER_ACTIONS_QUERY_MAX_RESULTS } from './tools/workspaceTools.js';

const MAX_CALL_RESULTS = 500;
const MAX_IDEMPOTENCY_TOMBSTONES = 10_000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

// Progressive tool exposure (#7624): a small always-on core (this pair, plus
// user-actions.query) is the only thing every mind turn sees at full
// schema by default. Everything else is grouped into a family and shown only
// as a one-line discoverable index until the mind calls tools.activate for
// it — see buildPersistentMindToolPrompt. Neither tool requires a capability:
// they only ever change what is SHOWN, never what a granted tool may do, so
// gating them on a grant would make that invariant harder to see, not easier.
const toolsActivateTool = Object.freeze({
  type: 'portos_tool',
  name: 'tools.activate',
  version: COS_TOOL_SCHEMA_VERSION,
  providerName: providerToolName('tools.activate'),
  aliases: [providerToolName('tools.activate')],
  description: `Expand full schemas for one or more tool families (${TOOL_ACTIVATION_FAMILIES.join(', ')}) for the rest of this turn, plus a short retention window afterward. Supply up to five exact toolNames from those granted families to prioritize the next actions when family schemas are budget-limited; repeating family activation alone does not resolve that limit. This only changes which schemas you are shown here — it never grants a capability this mind does not already hold.`,
  input_schema: zodToOpenApiSchema(toolsActivateInputSchema),
  output_schema: objectOutputSchema,
  policy: {
    scopes: ['mind'],
    requiredCapabilities: [],
    sideEffect: 'write',
    idempotent: true,
    async: false,
    confirmation: 'none',
  },
  adapter: { kind: 'tools-activate' },
});

const toolsDeactivateTool = Object.freeze({
  type: 'portos_tool',
  name: 'tools.deactivate',
  version: COS_TOOL_SCHEMA_VERSION,
  providerName: providerToolName('tools.deactivate'),
  aliases: [providerToolName('tools.deactivate')],
  description: 'Collapse one or more tool families back to their one-line discoverable index. Clears both this turn\'s selection and any retained lease. Omit families to clear all of them.',
  input_schema: zodToOpenApiSchema(toolsDeactivateInputSchema),
  output_schema: objectOutputSchema,
  policy: {
    scopes: ['mind'],
    requiredCapabilities: [],
    sideEffect: 'write',
    idempotent: true,
    async: false,
    confirmation: 'none',
  },
  adapter: { kind: 'tools-deactivate' },
});

// Everything except the voice tools, which are sourced dynamically per intent
// from voice/tools.js. Kept separate so the fail-fast family check below can
// validate it without forcing voiceTools() (and the module it lazily depends
// on) to evaluate at cosToolRegistry.js's own import time.
const staticToolCatalog = [
  ...sandboxTools,
  ...reportTools,
  toolsActivateTool,
  toolsDeactivateTool,
  ...recipeManagementTools,
  ...mindTools,
  userActionsQueryTool,
  artistProfileTool,
  ...browserVaultTools,
  maintenanceRefreshTool,
  ...skillTools,
  ...eidoverseTools,
];
const toolCatalog = (intent) => [...staticToolCatalog, ...voiceTools(intent)];
const toolCalls = new Map();
const toolCallFingerprints = new Map();

// Family membership per tool (#7624), mirroring the TOOL_GROUPS/GROUP_INTENT
// shape in voice/tools.js: a lookup table rather than a field on every tool
// literal, so the mapping and the fail-fast guard below can't drift apart
// silently. 'core' tools are always shown at full schema; everything else is
// hidden behind its family until tools.activate names it.
const CORE_TOOL_NAMES = Object.freeze(new Set(['tools.activate', 'tools.deactivate', 'user-actions.query']));
const MIND_FAMILY_BY_TOOL_NAME = Object.freeze({
  'maintenance.refresh': 'mind',
  'cos.create-task': 'tasks',
  'sandbox.models': 'tasks',
  'sandbox.delegate': 'tasks',
  'issues.list': 'issues',
  'issues.file': 'issues',
  'reports.fix': 'reports',
  'reports.next': 'reports',
  'reports.read': 'reports',
  'reports.record': 'reports',
  'mind.cleanup': 'mind',
  'mind.protect-memory': 'mind',
  'mind.review-memory': 'mind',
  'mind.choose-name': 'mind',
  'mind.thinking-presets': 'mind',
  'mind.request-thinking-preset': 'mind',
  'mind.local-context': 'mind',
  'mind.adjust-local-context': 'mind',
  'skills.list': 'mind',
  'skills.view': 'mind',
  'skills.manage': 'mind',
});

const familyForTool = (tool) => {
  if (!tool) return null;
  if (CORE_TOOL_NAMES.has(tool.name)) return 'core';
  if (tool.recipe || tool.adapter?.kind === 'recipe-management' || tool.adapter?.kind === 'recipe') return 'recipes';
  if (tool.adapter?.kind === 'voice-tool') return 'voice';
  if (tool.name.startsWith('eidoverse.')) return 'eidoverse';
  return MIND_FAMILY_BY_TOOL_NAME[tool.name] || null;
};

// Fail-fast at import time: every mind-scope tool must resolve to a real
// family or a forgotten mapping would silently make that tool
// undiscoverable — never shown even by name — once progressive exposure
// hides its schema. Saved recipes are exempt: they arrive at runtime from
// outside toolCatalog() and are always classified 'recipes' via `tool.recipe`.
for (const tool of staticToolCatalog) {
  if (tool.policy.scopes.includes('mind') && !familyForTool(tool)) {
    throw new Error(`cosToolRegistry: no tool-activation family mapped for mind-scope tool "${tool.name}"`);
  }
}

const normalizeToolCapabilities = (raw) => ({
  ...normalizePortosSemanticToolGrants(raw),
  delegateSandbox: raw?.delegateSandbox === true,
  createTasks: raw?.createTasks === true,
  fileIssues: raw?.fileIssues === true,
  auditReports: raw?.auditReports === true,
  manageToolRecipes: raw?.manageToolRecipes === true,
  manageMind: raw?.manageMind === true,
  chooseThinkingPreset: raw?.chooseThinkingPreset === true,
  adjustLocalContext: raw?.adjustLocalContext === true,
  manageSkills: raw?.manageSkills === true,
  promoteEidoverseFoundations: raw?.promoteEidoverseFoundations === true,
  installEidoverseControllers: raw?.installEidoverseControllers === true,
  callToolRecipes: raw?.callToolRecipes === true,
  browserVaultFill: raw?.browserVaultFill === true,
});

const publicTool = (tool, { scope, capabilities, reportAccess }) => {
  const missingCapabilities = tool.policy.requiredCapabilities
    .filter((capability) => capabilities[capability] !== true);
  const recipeAvailable = tool.recipe?.available !== false;
  const recipeDisabledReason = tool.recipe?.disabledReason
    || (missingCapabilities.includes('callToolRecipes') ? 'Saved recipe access is disabled for CoS Agent MCP.' : null)
    || (missingCapabilities.includes('manageToolRecipes') ? 'Saved recipe access is disabled for Persistent Mind.' : null)
    || (missingCapabilities.length ? `Requires ${missingCapabilities.join(', ')}.` : null);
  return {
    type: tool.type,
    name: tool.name,
    version: tool.version,
    providerName: tool.providerName,
    aliases: tool.aliases,
    description: tool.description,
    input_schema: tool.input_schema,
    output_schema: tool.output_schema,
    policy: tool.policy,
    // 'core' for the small always-on set, a family name for everything else
    // gated behind tools.activate, or null for a tool outside mind/agent
    // scope that progressive exposure never applies to. See #7624.
    family: familyForTool(tool),
    availableInScope: scope === 'all' || tool.policy.scopes.includes(scope),
    granted: !['agent', 'mind'].includes(scope)
      ? null
      : recipeAvailable && missingCapabilities.length === 0
        && (!tool.name.startsWith('reports.') || reportAccess?.granted !== false),
    ...(tool.name.startsWith('reports.') ? { requiresAppAuthorization: true, ...(reportAccess ? { access: reportAccess } : {}) } : {}),
    ...(tool.recipe ? { recipe: {
      ...tool.recipe,
      ...(recipeDisabledReason ? { disabledReason: recipeDisabledReason } : {}),
    } } : {}),
  };
};

export const getCosToolCatalog = ({ scope = 'all', intent, capabilities, recipes = [], reportAccess } = {}) => {
  const grants = normalizeToolCapabilities(capabilities);
  const tools = [...toolCatalog(intent), ...(['mind', 'agent'].includes(scope) ? recipes : [])]
    .filter((tool) => scope === 'all' || tool.policy.scopes.includes(scope))
    .map((tool) => publicTool(tool, { scope, capabilities: grants, reportAccess }));
  return {
    type: 'portos_tool_catalog',
    schemaVersion: COS_TOOL_SCHEMA_VERSION,
    scope,
    tools,
    stats: {
      total: tools.length,
      read: tools.filter((tool) => tool.policy.sideEffect === 'read').length,
      write: tools.filter((tool) => tool.policy.sideEffect !== 'read').length,
      granted: tools.filter((tool) => tool.granted === true).length,
    },
  };
};

export const formatCosToolCatalog = (catalog, format = 'portos') => {
  if (format === 'portos') return catalog;
  const tools = catalog.tools.filter((tool) => tool.granted !== false).map((tool) => {
    const description = tool.recipe
      ? `${tool.description} Saved local Persistent Mind recipe revision ${tool.recipe.revision}.`.slice(0, 500)
      : tool.description;
    if (format === 'openai') {
      return { type: 'function', function: { name: tool.providerName, description, parameters: tool.input_schema } };
    }
    if (format === 'anthropic') {
      return { name: tool.providerName, description, input_schema: tool.input_schema };
    }
    return {
      name: tool.providerName,
      description,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      annotations: {
        readOnlyHint: tool.policy.sideEffect === 'read',
        destructiveHint: tool.policy.sideEffect === 'destructive',
        idempotentHint: tool.policy.idempotent,
        openWorldHint: tool.policy.requiredCapabilities.includes('visitEidoversePeers'),
      },
    };
  });
  return { type: `${format}_tool_catalog`, schemaVersion: catalog.schemaVersion, scope: catalog.scope, tools };
};

export const readCosToolRecipeCatalog = async ({ scope = 'mind' } = {}) => {
  if (!['agent', 'mind'].includes(scope)) return [];
  return readRecipeToolsForScope(scope, getCosToolCatalog({ scope }).tools);
};

const TOOL_EXPOSURE_HEADER = 'You may request up to five calls from the exact catalog below. These are semantic actions, not raw HTTP routes. Never invent a name, route, or argument. Use a stable requestId when practical and never submit the same action in both toolCalls and taskRequests.';
const TOOL_EXPOSURE_FOOTER = 'Calls without requestId are coalesced by canonical tool name and arguments within this turn. Supply distinct requestId values only when two intentionally identical actions must both run.';
const TOOL_PURPOSE_MAX_CHARS = 160;

const renderToolPrompt = (tools, discoverableLines = []) => {
  const discoverableBlock = discoverableLines.length
    ? `\n\nDiscoverable-only families (schemas hidden to save context; call tools.activate with a "families" array to expand one for this turn and a short retention window after; include "toolNames" to prioritize specific budget-limited actions):\n${discoverableLines.join('\n')}`
    : '';
  return `# PortOS semantic tools
${TOOL_EXPOSURE_HEADER}

${JSON.stringify(tools)}${discoverableBlock}

${TOOL_EXPOSURE_FOOTER}`;
};

// First sentence, hard-capped: the whole point of the discoverable index is
// spending far fewer tokens per hidden tool than its full schema would.
const toolPurpose = (description) => {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const firstSentence = (text.match(/^.*?[.!?](?:\s|$)/)?.[0] || text).trim();
  return firstSentence.length > TOOL_PURPOSE_MAX_CHARS
    ? `${firstSentence.slice(0, TOOL_PURPOSE_MAX_CHARS - 1)}…`
    : firstSentence;
};

const fullSchemaShape = (tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema,
  sideEffect: tool.policy.sideEffect,
});

// One aggregate, tool-name-free line per turn (never per intermediate tool
// round — see the `trace` option below) so the exposure/retention behavior is
// observable in logs without ever naming a tool, an argument, or user text.
const logToolExposureTrace = (stats) => {
  const excluded = Object.entries(stats.excludedByReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(' ') || 'none';
  console.log(`🧰 Mind tool exposure: registered=${stats.registered} eligible=${stats.eligible} core=${stats.core} activated=${stats.activated} retained=${stats.retained} excluded(${excluded})`);
};

/**
 * Build the Persistent Mind's tool-catalog prompt section.
 *
 * Progressive exposure (#7624): a small always-on core plus family-scoped
 * explicit activation with a short turn-scoped retention lease, so a small
 * local model is never handed every granted tool's full JSON Schema on every
 * turn. `turnId`/`isUserTurn` age the lease at most once per USER turn — pass
 * `isUserTurn: false` (or omit it) for a self-directed wake and for every
 * intermediate tool-round rebuild within one turn. `trace: true` on exactly
 * one call per turn (the first) logs the one aggregate line for it.
 *
 * `capabilities.toolExposureAllSchemas` reproduces the pre-#7624 behavior
 * (every granted tool's full schema, always) for debugging.
 */
export const buildPersistentMindToolPrompt = async (capabilities, recipes = [], {
  turnId = null, isUserTurn = false, trace = false, maxChars = Infinity, requiredToolNames = [],
  requestedToolNames = [], activatedFamilies = [], onSelection,
} = {}) => {
  const grants = normalizePersistentMindCapabilities(capabilities);
  const reportAccess = grants.auditReports && grants.readPortos
    ? await import('../persistent/persistentMindProcessAudit.js').then(({ readProcessAuditAccess }) => readProcessAuditAccess()) : undefined;
  const catalog = getCosToolCatalog({ scope: 'mind', capabilities, recipes, reportAccess });
  const granted = catalog.tools.filter((tool) => tool.granted);
  // tools.activate/tools.deactivate are withheld along with everything else
  // when there is nothing else granted to activate — matching the pre-#7624
  // "semantic tool access is OFF" contract exactly for a fully ungranted mind.
  const meaningful = granted.filter((tool) => !['tools.activate', 'tools.deactivate'].includes(tool.name));
  if (meaningful.length === 0) {
    if (trace) {
      logToolExposureTrace({
        registered: catalog.tools.length, eligible: 0, core: 0, activated: 0, retained: 0,
        excludedByReason: { ungranted: catalog.tools.length },
      });
    }
    return `# PortOS semantic tools
Semantic tool access is OFF. Return an empty toolCalls array. Never invent a tool name or claim that a PortOS action ran.`;
  }

  if (grants.toolExposureAllSchemas) {
    if (trace) {
      logToolExposureTrace({
        registered: catalog.tools.length, eligible: granted.length, core: granted.length, activated: 0, retained: 0,
        excludedByReason: { ungranted: catalog.tools.length - granted.length },
      });
    }
    onSelection?.(granted.map((tool) => tool.name));
    return renderToolPrompt(granted.map(fullSchemaShape));
  }

  const readCurrentLeases = async () => normalizePersistentMindToolActivation((await loadState()).persistentMind?.toolActivation);
  let activation = await readCurrentLeases();
  if (isUserTurn && turnId && activation.lastAgedTurnId !== turnId) {
    activation = await withStateLock(async () => {
      const root = await loadState();
      const latest = normalizePersistentMindToolActivation(root.persistentMind.toolActivation);
      if (latest.lastAgedTurnId === turnId) return latest;
      const { leases } = agePersistentMindToolActivation(latest.leases);
      const next = { leases, lastAgedTurnId: turnId };
      root.persistentMind = { ...root.persistentMind, toolActivation: next };
      await saveState(root);
      return next;
    });
  }

  const requested = new Set(requestedToolNames);
  const exposedFamilies = new Set([...Object.keys(activation.leases), ...activatedFamilies]);
  const controlTools = granted.filter((tool) => ['tools.activate', 'tools.deactivate'].includes(tool.name));
  const exposedTools = [];
  const discoverableByFamily = new Map();
  for (const tool of meaningful) {
    if (tool.family === 'core' || exposedFamilies.has(tool.family) || requested.has(tool.name)) {
      exposedTools.push(tool);
    } else {
      if (!discoverableByFamily.has(tool.family)) discoverableByFamily.set(tool.family, []);
      discoverableByFamily.get(tool.family).push(tool);
    }
  }

  if (trace) {
    // A family sitting at its full retention value looks freshly
    // (re)activated; one that has aged down is coasting on retention alone.
    // This distinguishes the two counts without any extra persisted state.
    const leaseValues = Object.values(activation.leases);
    const activated = leaseValues.filter((turnsLeft) => turnsLeft === grants.toolExposureRetentionTurns).length;
    logToolExposureTrace({
      registered: catalog.tools.length,
      eligible: granted.length,
      core: controlTools.length + meaningful.filter((tool) => tool.family === 'core').length,
      activated,
      retained: leaseValues.length - activated,
      excludedByReason: {
        ungranted: catalog.tools.length - granted.length,
        notActivated: [...discoverableByFamily.values()].reduce((sum, tools) => sum + tools.length, 0),
      },
    });
  }

  const required = new Set(requiredToolNames);
  const prioritized = [...exposedTools].sort((left, right) => {
    const leftRequired = requested.has(left.name) ? 2 : required.has(left.name) ? 1 : 0;
    const rightRequired = requested.has(right.name) ? 2 : required.has(right.name) ? 1 : 0;
    return rightRequired - leftRequired;
  });
  const selectedTools = [];
  let selectedChars = 0;
  for (const tool of prioritized) {
    const rendered = JSON.stringify(fullSchemaShape(tool));
    if (selectedChars + rendered.length > maxChars) continue;
    selectedTools.push(tool);
    selectedChars += rendered.length;
  }
  const renderSelection = () => {
    const budgetLimitedByFamily = new Map();
    for (const tool of prioritized.filter((candidate) => !selectedTools.includes(candidate))) {
      if (!budgetLimitedByFamily.has(tool.family)) budgetLimitedByFamily.set(tool.family, []);
      budgetLimitedByFamily.get(tool.family).push(tool);
    }
    const discoverableLines = [...discoverableByFamily.entries()].map(([family, tools]) => (
      `- ${family} (${tools.length}): ${tools.map((tool) => `${tool.name} — ${toolPurpose(tool.description)}`).join('; ')}`
    )).concat([...budgetLimitedByFamily.entries()].map(([family, tools]) => (
      `- ${family} (${tools.length}, budget-limited): ${tools.map((tool) => `${tool.name} — ${toolPurpose(tool.description)}`).join('; ')}`
    )));
    return renderToolPrompt([...controlTools, ...selectedTools].map(fullSchemaShape), discoverableLines);
  };

  while (selectedTools.length > 0 && renderSelection().length > maxChars) {
    // Priorities never override the complete schema budget. Completed action
    // receipts still identify earlier calls even when their schemas no longer fit.
    selectedTools.pop();
  }

  onSelection?.([...controlTools, ...selectedTools].map((tool) => tool.name));
  return renderSelection();
};

/**
 * Read-only cost of the tool-catalog section a wake would currently render:
 * total characters plus the full-schema characters each exposed family holds.
 * Never ages a lease or logs (no turnId/isUserTurn/trace); `overheadChars` is
 * the header, footer and discoverable-family index around the schemas. Names
 * and counts only, no schema text.
 */
export const describePersistentMindToolCost = async (capabilities, recipes = []) => {
  let selectedNames = [];
  const prompt = await buildPersistentMindToolPrompt(capabilities, recipes, { onSelection: (names) => { selectedNames = names; } });
  const byName = new Map(getCosToolCatalog({ scope: 'mind', capabilities, recipes }).tools.map((tool) => [tool.name, tool]));
  const families = new Map();
  for (const name of selectedNames) {
    const tool = byName.get(name);
    const family = tool?.family || 'other';
    const entry = families.get(family) || { family, tools: 0, chars: 0 };
    entry.tools += 1;
    entry.chars += tool ? JSON.stringify(fullSchemaShape(tool)).length : 0;
    families.set(family, entry);
  }
  const familyList = [...families.values()];
  const schemaChars = familyList.reduce((sum, entry) => sum + entry.chars, 0);
  return { totalChars: prompt.length, overheadChars: Math.max(0, prompt.length - schemaChars), families: familyList };
};

export const readPersistentMindRecipeCatalog = (capabilities) => readMindRecipeTools(capabilities, getCosToolCatalog({ scope: 'mind' }).tools);

const resolveTool = (name) => toolCatalog().find((tool) =>
  tool.name === name || tool.providerName === name || tool.aliases.includes(name));

export const isCosTaskToolName = (name) => resolveTool(name)?.adapter.kind === 'persistent-mind-task';

const validateAuthority = (tool, authority) => {
  const scope = authority?.scope || 'ui';
  if (!tool.policy.scopes.includes(scope)) {
    throw new ServerError(`Tool '${tool.name}' is unavailable in the ${scope} scope`, { status: 403, code: 'TOOL_SCOPE_DENIED' });
  }
  if (scope === 'mind' || scope === 'agent') {
    const capabilities = normalizeToolCapabilities(authority.capabilities);
    const missing = tool.policy.requiredCapabilities.filter((capability) => capabilities[capability] !== true);
    if (missing.length) {
      throw new ServerError(`Tool '${tool.name}' is not granted to the ${scope} principal`, { status: 403, code: 'TOOL_CAPABILITY_DENIED' });
    }
  }
  if (scope === 'ui' && tool.policy.sideEffect !== 'read' && authority?.authenticated !== true) {
    throw new ServerError('Mutating tool calls require an authenticated PortOS session', { status: 403, code: 'TOOL_AUTH_REQUIRED' });
  }
};

const validateArguments = (tool, args) => {
  // JSON Schema does not carry JavaScript regexp flags; keep the Unicode
  // naming contract on its original Zod schema at the execution boundary.
  const schema = tool.adapter.kind === 'persistent-mind-name'
    ? persistentMindChooseNameSchema : z.fromJSONSchema(tool.input_schema);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new ServerError(`Invalid arguments for '${tool.name}': ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`, {
      status: 400,
      code: 'TOOL_VALIDATION_ERROR',
    });
  }
  return parsed.data;
};

const resolveTargetFamilies = async (targeted, args, authority) => {
  const recipes = targeted.some((name) => name.startsWith('recipe.'))
    ? await readPersistentMindRecipeCatalog(authority?.capabilities) : [];
  const reportAccess = targeted.some(name => name.startsWith('reports.'))
    ? await import('../persistent/persistentMindProcessAudit.js').then(({ readProcessAuditAccess }) => readProcessAuditAccess()) : undefined;
  const catalog = getCosToolCatalog({ scope: 'mind', capabilities: authority?.capabilities, recipes, reportAccess });
  if (targeted.some((name) => !catalog.tools.some((entry) => entry.name === name
    && entry.granted && args.families.includes(entry.family)))) {
    throw new ServerError('Requested tool names must belong to the selected granted families', { status: 403, code: 'TOOL_CAPABILITY_DENIED' });
  }
  return Object.fromEntries(catalog.tools.filter((entry) => targeted.includes(entry.name)).map((entry) => [entry.name, entry.family]));
};

// tools.activate and tools.deactivate share one lease write, parameterised by kind.
const toggleToolFamilies = async (tool, args, context, authority) => {
  const activate = tool.adapter.kind === 'tools-activate';
  const grants = normalizePersistentMindCapabilities(authority?.capabilities);
  const targeted = activate && args.toolNames ? [...new Set(args.toolNames)] : [];
  const targetFamilies = targeted.length ? await resolveTargetFamilies(targeted, args, authority) : undefined;
  return withStateLock(async () => {
    const root = await loadState();
    const current = normalizePersistentMindToolActivation(root.persistentMind.toolActivation);
    const leases = activate
      ? activatePersistentMindToolActivationFamilies(current.leases, args.families, grants.toolExposureRetentionTurns)
      : deactivatePersistentMindToolActivationFamilies(current.leases, args.families);
    root.persistentMind = { ...root.persistentMind, toolActivation: { leases, lastAgedTurnId: current.lastAgedTurnId } };
    await saveState(root);
    return activate
      ? { ok: true, activated: args.families, retentionTurns: grants.toolExposureRetentionTurns, families: Object.keys(leases),
        ...(targeted.length ? { requestedToolNames: targeted, targetFamilies } : {}),
        schemaNote: 'Family activation is budget-limited. Target exact toolNames for the next action; identical reactivation does not change the schema budget.' }
      : { ok: true, deactivated: args.families || TOOL_ACTIVATION_FAMILIES, families: Object.keys(leases) };
  });
};

// Each handler is (tool, args, context, authority) => result.
const ADAPTER_HANDLERS = {
  ...eidoverseAdapterHandlers,
  ...mindAdapterHandlers,
  ...voiceAdapterHandlers,
  ...workspaceAdapterHandlers,
  'recipe-management': (tool, args, context) => executeRecipeManagement(tool, args, context),
  recipe: executeRecipe,
  'tools-activate': toggleToolFamilies,
  'tools-deactivate': toggleToolFamilies,
};

const resolveAdapterHandler = (kind) => {
  if (!Object.hasOwn(ADAPTER_HANDLERS, kind)) {
    throw new ServerError('Unknown tool adapter', { status: 500, code: 'TOOL_ADAPTER_MISSING' });
  }
  return ADAPTER_HANDLERS[kind];
};

const trimCallResults = () => {
  while (toolCalls.size > MAX_CALL_RESULTS) toolCalls.delete(toolCalls.keys().next().value);
};

const pruneToolCallFingerprints = (now = Date.now()) => {
  for (const [requestId, entry] of toolCallFingerprints) {
    if (entry.expiresAt > now) break;
    toolCallFingerprints.delete(requestId);
  }
  while (toolCallFingerprints.size > MAX_IDEMPOTENCY_TOMBSTONES) {
    toolCallFingerprints.delete(toolCallFingerprints.keys().next().value);
  }
};

const normalizeAdapterResult = ({ parsedCall, tool, result }) => {
  const parsedResult = z.record(z.string(), z.unknown()).safeParse(result);
  const base = {
    type: 'portos_tool_result',
    requestId: parsedCall.requestId,
    name: tool.name,
    version: COS_TOOL_SCHEMA_VERSION,
    duplicate: false,
  };
  if (!parsedResult.success) {
    return { ...base, state: 'failed', error: 'Tool adapter returned an invalid result' };
  }
  // Every tool result can reach a model: redact any secret a host-side flow
  // (the model-blind browser fill) registered, wherever an adapter echoed it.
  const data = scrubEphemeralSecretsDeep(parsedResult.data);
  const failed = data.ok === false || data.state === 'failed';
  return {
    ...base,
    state: failed ? 'failed' : 'completed',
    ...(failed ? { error: String(data.error || data.summary || 'Tool adapter reported failure').slice(0, 500) } : {}),
    result: data,
  };
};

// A successful mind-scope call from a leased/activatable family renews only
// that family's window — an unrelated activated-but-unused family still ages
// normally. Never runs for 'core'/unclassified tools (nothing to renew) or
// under the all-schemas escape hatch (leases are inert there). Errors are
// swallowed: a lease-bookkeeping failure must never turn a completed tool
// call into a failed one.
const renewToolActivationLeaseOnUse = async (tool, authority, succeeded) => {
  if (!succeeded || authority?.scope !== 'mind') return;
  const family = familyForTool(tool);
  if (!family || family === 'core') return;
  const grants = normalizePersistentMindCapabilities(authority.capabilities);
  if (grants.toolExposureAllSchemas || !(grants.toolExposureRetentionTurns > 0)) return;
  await withStateLock(async () => {
    const root = await loadState();
    const current = normalizePersistentMindToolActivation(root.persistentMind.toolActivation);
    const leases = renewPersistentMindToolActivationFamily(current.leases, family, grants.toolExposureRetentionTurns);
    root.persistentMind = { ...root.persistentMind, toolActivation: { leases, lastAgedTurnId: current.lastAgedTurnId } };
    await saveState(root);
  });
};

export const executeCosToolCall = async ({ call, authority, context = {} }) => {
  const parsedCall = cosToolCallSchema.parse(call);
  let tool = resolveTool(parsedCall.name);
  if (parsedCall.name.startsWith('recipe.')) {
    const scope = authority?.scope;
    if (!['agent', 'mind'].includes(scope)) throw new ServerError('Recipes require mind or agent scope', { status: 403, code: 'TOOL_SCOPE_DENIED' });
    authority = scope === 'agent'
      ? await currentAgentAuthority(authority)
      : await currentMindAuthority(authority);
    const accessCapability = scope === 'agent' ? 'callToolRecipes' : 'manageToolRecipes';
    if (authority.capabilities[accessCapability] !== true) throw new ServerError('Recipe access is not granted', { status: 403, code: 'TOOL_CAPABILITY_DENIED' });
    const { getRecipeByName } = await import('../mindToolRecipes.js');
    tool = await resolveRecipeInvocation(await getRecipeByName(parsedCall.name), getCosToolCatalog({ scope }).tools, { scope });
  } else if (['recipe-management', 'persistent-mind-memory-review'].includes(tool?.adapter.kind) && authority?.scope === 'mind') {
    authority = await currentMindAuthority(authority);
  }
  if (!tool) throw new ServerError(`Unknown tool '${parsedCall.name}'`, { status: 404, code: 'TOOL_NOT_FOUND' });
  validateAuthority(tool, authority);
  const handler = resolveAdapterHandler(tool.adapter.kind);
  const args = validateArguments(tool, parsedCall.arguments);
  if (tool.adapter.kind.startsWith('reports.')) {
    const { assertProcessAuditAccess } = await import('../persistent/persistentMindProcessAudit.js');
    await assertProcessAuditAccess(args.appId);
  }
  const fingerprint = sha256Text(canonicalStringify({ name: tool.name, arguments: args, scope: authority?.scope || 'ui', ...(tool.adapter.kind.startsWith('reports.') ? { turnId: context.turnId || null } : {}), ...(tool.adapter.kind === 'recipe' ? { recipeId: tool.adapter.recipe.id, revision: tool.adapter.recipe.activeRevision } : {}) }));
  pruneToolCallFingerprints();
  // Durable memory outcomes must recheck ownership/version/protection on retries,
  // while retaining the shared request-id conflict and lease-renewal contracts.
  const durableReplay = tool.adapter.kind === 'persistent-mind-memory-review';
  const existing = toolCalls.get(parsedCall.requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new ServerError('requestId was already used for a different tool call', { status: 409, code: 'TOOL_IDEMPOTENCY_CONFLICT' });
    }
    if (!durableReplay) {
      const result = await existing.promise;
      return { ...result, duplicate: true };
    }
  }
  const retainedFingerprint = toolCallFingerprints.get(parsedCall.requestId);
  if (retainedFingerprint) {
    if (retainedFingerprint.fingerprint !== fingerprint) {
      throw new ServerError('requestId was already used for a different tool call', { status: 409, code: 'TOOL_IDEMPOTENCY_CONFLICT' });
    }
    if (!durableReplay) throw new ServerError('requestId result has expired and cannot be replayed safely', { status: 409, code: 'TOOL_IDEMPOTENCY_EXPIRED' });
  }

  const promise = Promise.resolve()
    .then(() => handler(tool, args, { ...context, requestId: parsedCall.requestId }, authority))
    .then(
      (result) => normalizeAdapterResult({ parsedCall, tool, result }),
      (error) => ({
        type: 'portos_tool_result',
        requestId: parsedCall.requestId,
        name: tool.name,
        version: COS_TOOL_SCHEMA_VERSION,
        state: 'failed',
        duplicate: false,
        error: scrubEphemeralSecrets(String(error?.message || error || 'Tool execution failed')).slice(0, 500),
      }),
    )
    .then(async (normalized) => {
      await renewToolActivationLeaseOnUse(tool, authority, normalized.state === 'completed').catch(() => {});
      return normalized;
    });
  toolCallFingerprints.set(parsedCall.requestId, {
    fingerprint,
    expiresAt: Date.now() + IDEMPOTENCY_RETENTION_MS,
  });
  pruneToolCallFingerprints();
  toolCalls.set(parsedCall.requestId, { fingerprint, promise,
    ...(tool.adapter.kind.startsWith('reports.') ? { reportAppId: args.appId } : {}),
  });
  trimCallResults();
  return promise;
};

export const getCosToolCall = async (requestId) => {
  const entry = toolCalls.get(requestId);
  if (!entry) return null;
  const result = await entry.promise;
  if (entry.reportAppId) {
    const { assertProcessAuditAccess } = await import('../persistent/persistentMindProcessAudit.js');
    await assertProcessAuditAccess(entry.reportAppId);
  }
  return result;
};

export const __testing = { VOICE_ADAPTERS, resolveTool, toolCalls, toolCallFingerprints };
