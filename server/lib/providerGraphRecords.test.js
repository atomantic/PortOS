/**
 * The durable provider-graph record contract (#6367).
 *
 * These are the assertions that stand between a provider-configuration import
 * and silent data loss, so they live at the pure layer where every branch is
 * reachable without a Postgres or a temp directory:
 *
 *   - an import round-trips every executable record byte-for-byte, custom
 *     fields and secrets included, because that round-trip IS the downgrade
 *     contract;
 *   - the client DTO carries credential PRESENCE and nothing else;
 *   - a crash between the DB commit and the file write is recoverable, and a
 *     third writer's value is never overwritten to recover it;
 *   - an edit made by a downgraded release or an old client detaches, updates
 *     or splits the right rows and resurrects nothing.
 *
 * Every fixture is synthetic. Nothing here is read out of a running install.
 */

import { describe, expect, it } from 'vitest';
import { buildProviderGraphPreview } from './providerGraphPreview.js';
import { withConnectionOwnedFields } from './providerConnections.js';
import {
  connectionOwnedSnapshot,
  graphFromPreview,
  importGraphFromProviders,
  planGraphReconciliation,
  reconciliationIsNoop,
  toManagementGraphDto,
} from './providerGraphRecords.js';

// A deterministic id minter so a plan can be asserted without matching UUIDs.
const minter = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
};

const CLAUDE_CLI = Object.freeze({
  id: 'claude-ollama',
  name: 'Claude on the example daemon',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  enabled: true,
  models: ['example-model:8b'],
  defaultModel: 'example-model:8b',
  envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'example-token' },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  // A field no module in this tree has ever heard of. It must survive import.
  someFutureField: { nested: [1, 2, 3] },
});
const CLAUDE_TUI = Object.freeze({
  ...CLAUDE_CLI,
  id: 'claude-ollama-tui',
  type: 'tui',
  enabled: false,
  textTransport: 'tui',
  textTransportEnabled: true,
});
const REMOTE_API = Object.freeze({
  id: 'remote-ollama',
  name: 'Remote Ollama',
  type: 'api',
  endpoint: 'https://ollama.example.com/v1',
  apiKey: 'example-remote-key',
  enabled: true,
  models: [],
});

// Deep clones: the CLI and TUI literals deliberately SHARE one `envVars`
// object (that is what makes them siblings), so a shallow copy would let one
// test's edit reach the other record and the next test's fixture.
const providersFixture = () => [CLAUDE_CLI, CLAUDE_TUI, REMOTE_API].map((record) => structuredClone(record));

/** The graph an install with these records would import, plus the records. */
const imported = (providers = providersFixture(), mintId = minter()) => ({
  providers,
  graph: importGraphFromProviders({ providers }, mintId),
});

describe('importing an install into durable rows', () => {
  it('round-trips every executable record, including unknown custom fields', () => {
    // The import-fidelity proof and the downgrade contract are the same
    // assertion: a downgraded release runs providers.json with no graph, so a
    // record missing a connection-owned value would stop executing.
    const providers = providersFixture();
    const { graph } = imported(providers);
    const snapshots = new Map(graph.routes.map((route) => [route.providerId, route.projected]));
    const rematerialized = providers.map((provider) =>
      withConnectionOwnedFields(provider, snapshots.get(provider.id)));
    expect(rematerialized).toEqual(providers);
  });

  it('keeps the executable provider ids and mints UUID-shaped ids for the graph', () => {
    const { graph } = imported();
    // Saved selections everywhere in PortOS name these strings.
    expect(graph.routes.map((route) => route.providerId).sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'remote-ollama']);
    // Graph identity is durable and independent of any provider id, so a
    // rename cannot break a link.
    for (const connection of graph.connections) expect(connection.id).not.toContain('claude');
  });

  it('OR-enables a proven CLI/TUI sibling pair without touching either route', () => {
    const { providers, graph } = imported();
    const binding = graph.bindings.find((candidate) => candidate.harnessId === 'claude');
    expect(binding.enabled).toBe(true); // CLI enabled, TUI disabled
    // The per-route records keep their own enabled flags and their consent.
    expect(providers.find((p) => p.id === 'claude-ollama-tui').enabled).toBe(false);
    expect(providers.find((p) => p.id === 'claude-ollama-tui').textTransportEnabled).toBe(true);
  });

  it('imports a disabled or custom route rather than dropping it', () => {
    const custom = { id: 'custom-cli', name: 'Custom', type: 'cli', command: 'claude', enabled: false, models: [] };
    const { graph } = imported([...providersFixture(), custom]);
    expect(graph.routes.map((route) => route.providerId)).toContain('custom-cli');
  });

  it('leaves an unmappable record as a legacy route with no row at all', () => {
    // An unknown harness stays executable and unmanaged, never guessed into a
    // connection it might not reach.
    const unknown = { id: 'mystery', name: 'Mystery', type: 'cli', command: 'mystery-bin', enabled: true, models: [] };
    const { graph } = imported([...providersFixture(), unknown]);
    expect(graph.routes.map((route) => route.providerId)).not.toContain('mystery');
  });
});

describe('the client DTO', () => {
  const dto = () => toManagementGraphDto({ ...imported().graph, activeProvider: 'claude-ollama' });

  it('publishes credential presence and never a credential or a snapshot', () => {
    const serialized = JSON.stringify(dto());
    expect(serialized).not.toContain('example-token');
    expect(serialized).not.toContain('example-remote-key');
    expect(serialized).not.toContain('projected');
    expect(dto().connections.every((connection) => connection.hasCredentials)).toBe(true);
  });

  it('publishes the same executable activeProvider string as the flat API', () => {
    expect(dto().activeProvider).toBe('claude-ollama');
  });

  it('marks a binding blocked while one of its routes has an unsettled projection', () => {
    const graph = imported().graph;
    graph.routes[0].pending = { fields: {}, envVars: {}, hasEnvVars: true };
    const blocked = toManagementGraphDto(graph).bindings.filter((binding) => binding.blocked);
    expect(blocked.map((binding) => binding.id)).toEqual([graph.routes[0].bindingId]);
  });
});

describe('recovering an interrupted projection', () => {
  /** A graph whose first Claude route is mid-projection to `pendingUrl`. */
  const midProjection = (pendingUrl) => {
    const providers = providersFixture();
    const { graph } = imported(providers);
    const route = graph.routes.find((candidate) => candidate.providerId === 'claude-ollama');
    route.pending = {
      ...route.projected,
      envVars: { ...route.projected.envVars, ANTHROPIC_BASE_URL: pendingUrl },
    };
    return { providers, graph, route };
  };

  it('acknowledges a projection whose file write landed', () => {
    const { providers, graph } = midProjection('http://127.0.0.1:9999');
    // The crash happened AFTER the file write, so the file already holds it.
    providers.find((p) => p.id === 'claude-ollama').envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999';

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    expect(plan.acknowledgements).toEqual([{ providerId: 'claude-ollama' }]);
    expect(plan.retries).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('retries a projection whose file write did not land', () => {
    const { providers, graph, route } = midProjection('http://127.0.0.1:9999');
    // The file still holds the pre-projection value.
    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    expect(plan.retries).toEqual([{ providerId: 'claude-ollama', owned: route.pending }]);
    expect(plan.acknowledgements).toEqual([]);
  });

  it('REFUSES to overwrite a third value a different writer put there', () => {
    // This is the assertion the whole two-snapshot design exists for: matching
    // neither snapshot means someone else edited the file, and a retry would
    // destroy their change.
    const { providers, graph } = midProjection('http://127.0.0.1:9999');
    providers.find((p) => p.id === 'claude-ollama').envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:7777';

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    expect(plan.conflicts).toEqual([
      { providerId: 'claude-ollama', bindingId: expect.any(String), reason: 'external-change' },
    ]);
    expect(plan.retries).toEqual([]);
    expect(plan.acknowledgements).toEqual([]);
    // Nothing about the disputed route is regrouped or re-snapshotted either.
    expect(plan.snapshots.map((snapshot) => snapshot.providerId)).not.toContain('claude-ollama');
  });
});

describe('reconciling after a downgrade edited providers.json', () => {
  it('is a no-op when nothing moved, and keeps every UUID', () => {
    const { providers, graph } = imported();
    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    expect(reconciliationIsNoop(plan)).toBe(true);
    expect(plan.regroups.every((regroup) => regroup.connectionAction === 'unchanged')).toBe(true);
    const original = new Set(graph.connections.map((connection) => connection.id));
    for (const regroup of plan.regroups) expect(original.has(regroup.connection.id)).toBe(true);
  });

  it('updates an EXCLUSIVE connection in place when its backend moved', () => {
    const providers = providersFixture();
    const { graph } = imported(providers);
    for (const id of ['claude-ollama', 'claude-ollama-tui']) {
      providers.find((p) => p.id === id).envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:12345';
    }

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const claude = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama'));
    expect(claude.connectionAction).toBe('update');
    // Only one binding uses it, so nothing else can be repointed by the edit —
    // the row keeps its id and the routes keep their binding.
    expect(claude.connection.id).toBe(graph.bindings.find((b) => b.harnessId === 'claude').connectionId);
    expect(claude.bindingId).toBeTruthy();
    expect(plan.snapshots.map((snapshot) => snapshot.providerId).sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui']);
  });

  it('CLONES a shared connection rather than repointing another harness', () => {
    // Two harnesses on one connection is the whole point of the graph; an edit
    // to one of them must not silently move the other's backend.
    const providers = providersFixture();
    const { graph } = imported(providers);
    const claudeBinding = graph.bindings.find((binding) => binding.harnessId === 'claude');
    const apiBinding = graph.bindings.find((binding) => binding.harnessId === null);
    apiBinding.connectionId = claudeBinding.connectionId;

    for (const id of ['claude-ollama', 'claude-ollama-tui']) {
      providers.find((p) => p.id === id).envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:12345';
    }

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const claude = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama'));
    expect(claude.connectionAction).toBe('clone');
    expect(claude.connection.id).not.toBe(claudeBinding.connectionId);
    expect(claude.bindingId).toBe(claudeBinding.id); // route ids and binding retained
  });

  it('SPLITS a binding whose siblings now disagree with each other', () => {
    const providers = providersFixture();
    const { graph } = imported(providers);
    // Only the TUI half was repointed — the two are no longer one connection.
    providers.find((p) => p.id === 'claude-ollama-tui').envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:12345';

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const split = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama-tui'));
    expect(split.bindingId).toBeNull();
    expect(split.binding.harnessId).toBe('claude');
    // A distinct labeled variant, never a merge that would discard a route id.
    expect(split.binding.variantKey).toBe('variant:claude-ollama-tui');
    expect(split.connectionAction).toBe('clone');
    // The CLI half keeps the original binding and connection.
    const kept = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama'));
    expect(kept.connectionAction).toBe('unchanged');
  });

  it('drops a deleted record without resurrecting it', () => {
    const providers = providersFixture().filter((provider) => provider.id !== 'remote-ollama');
    const { graph } = imported(providersFixture());

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    expect(plan.removals).toEqual(['remote-ollama']);
    expect(plan.imports.routes).toEqual([]);
    // The emptied binding/connection are left for explicit cleanup, not deleted
    // and not refilled with a route the user removed.
    expect(plan.regroups.some((regroup) => regroup.routeIds.includes('remote-ollama'))).toBe(false);
  });

  it('imports a record added while the graph was not running', () => {
    const added = { id: 'codex-cli', name: 'Codex', type: 'cli', command: 'codex', enabled: true, models: [] };
    const { graph } = imported(providersFixture());

    const plan = planGraphReconciliation(graph, [...providersFixture(), added], { mintId: minter('new') });
    expect(plan.imports.routes.map((route) => route.providerId)).toEqual(['codex-cli']);
    // Imported as its own fragment — never auto-linked into an existing
    // connection on a name or vendor match.
    expect(plan.imports.connections).toHaveLength(1);
  });

  it('rebuilds isolated mappings when a restore brought the file but not the graph', () => {
    // Half a backup: providers.json is present, the DB tables are empty. Every
    // record is simply unmapped, so the same import path rebuilds them — with
    // the cross-harness link metadata legitimately lost.
    const providers = providersFixture();
    const plan = planGraphReconciliation({ connections: [], bindings: [], routes: [] }, providers,
      { mintId: minter('new') });
    expect(plan.imports.routes.map((route) => route.providerId).sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'remote-ollama']);
    expect(plan.removals).toEqual([]);
  });

  it('drops rows whose records a restore did not bring back', () => {
    // The other half: the DB has the graph, the provider file is a bare seed.
    const { graph } = imported(providersFixture());
    const plan = planGraphReconciliation(graph, [], { mintId: minter('new') });
    expect(plan.removals.sort()).toEqual(['claude-ollama', 'claude-ollama-tui', 'remote-ollama']);
  });
});

describe('a connection several harnesses share through different protocols', () => {
  // One local daemon reached by Claude on its Anthropic port and Codex on its
  // OpenAI-compatible port, linked into ONE connection row. A provider record
  // names one endpoint, so each route reports exactly one transport — the row
  // therefore CONTAINS what its routes describe rather than equalling it, and a
  // reconcile pass that demanded equality would clone every binding off it.
  const DAEMON = 'http://127.0.0.1:11434';
  const DAEMON_V1 = 'http://127.0.0.1:11434/v1';
  const TOKEN = 'example-token';
  const OPENAI_KEY = 'example-openai-key';

  const CODEX_CLI = Object.freeze({
    id: 'codex-ollama',
    name: 'Codex on the example daemon',
    type: 'cli',
    command: 'codex',
    ollamaBacked: true,
    enabled: false,
    models: ['example-model:8b'],
    envVars: { OPENAI_BASE_URL: DAEMON_V1, OPENAI_API_KEY: OPENAI_KEY },
    secretEnvVars: ['OPENAI_API_KEY'],
  });

  const CONNECTION = 'conn-shared';
  const CLAUDE_BINDING = 'binding-claude';
  const CODEX_BINDING = 'binding-codex';

  const shared = () => {
    const providers = [CLAUDE_CLI, CLAUDE_TUI, CODEX_CLI].map((record) => structuredClone(record));
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const route = (providerId, bindingId, mode) => ({
      providerId,
      bindingId,
      mode,
      modelMap: { 'example-model:8b': 'example-model:8b' },
      projected: connectionOwnedSnapshot(byId.get(providerId)),
      pending: null,
      pendingRevision: null,
    });
    return {
      providers,
      graph: {
        connections: [{
          id: CONNECTION,
          revision: 3,
          kind: 'ollama',
          label: 'Example local daemon',
          transports: { anthropic: { baseUrl: DAEMON }, openai: { baseUrl: DAEMON_V1 } },
          credentials: { ANTHROPIC_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: OPENAI_KEY },
          catalog: { state: 'known', models: ['example-model:8b'] },
        }],
        bindings: [
          {
            id: CLAUDE_BINDING, revision: 4, connectionId: CONNECTION, harnessId: 'claude',
            variantKey: 'default', label: 'Claude', enabled: true, selectedModels: ['example-model:8b'],
          },
          {
            id: CODEX_BINDING, revision: 2, connectionId: CONNECTION, harnessId: 'codex',
            variantKey: 'default', label: 'Codex', enabled: false, selectedModels: [],
          },
        ],
        routes: [
          route('claude-ollama', CLAUDE_BINDING, 'cli'),
          route('claude-ollama-tui', CLAUDE_BINDING, 'tui'),
          route('codex-ollama', CODEX_BINDING, 'cli'),
        ],
      },
    };
  };

  it('survives a reconcile pass with every binding still on it', () => {
    const { providers, graph } = shared();
    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });

    expect(reconciliationIsNoop(plan)).toBe(true);
    expect(plan.regroups.every((regroup) => regroup.connectionAction === 'unchanged')).toBe(true);
    for (const regroup of plan.regroups) expect(regroup.connection.id).toBe(CONNECTION);
    // The row keeps BOTH protocols: a single-transport route must never narrow
    // the backend the other harness reaches.
    for (const regroup of plan.regroups) {
      expect(Object.keys(regroup.connection.transports).sort()).toEqual(['anthropic', 'openai']);
    }
  });

  it('still detaches the one harness whose base URL genuinely moved', () => {
    const { providers, graph } = shared();
    for (const id of ['claude-ollama', 'claude-ollama-tui']) {
      providers.find((provider) => provider.id === id).envVars.ANTHROPIC_BASE_URL = 'http://127.0.0.1:12345';
    }

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const claude = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama'));
    // Shared, so the moved harness gets its own row instead of repointing Codex.
    expect(claude.connectionAction).toBe('clone');
    expect(claude.connection.id).not.toBe(CONNECTION);
    expect(claude.bindingId).toBe(CLAUDE_BINDING);
    // Codex never noticed.
    const codex = plan.regroups.find((regroup) => regroup.routeIds.includes('codex-ollama'));
    expect(codex.connectionAction).toBe('unchanged');
    expect(codex.connection.id).toBe(CONNECTION);
  });

  it('detaches a route whose credential disagrees with the shared one', () => {
    // A subset is normal — two protocols, two keys. A route claiming a
    // DIFFERENT value for a key the connection already carries is not.
    const { providers, graph } = shared();
    for (const id of ['claude-ollama', 'claude-ollama-tui']) {
      providers.find((provider) => provider.id === id).envVars.ANTHROPIC_AUTH_TOKEN = 'example-other-token';
    }

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const claude = plan.regroups.find((regroup) => regroup.routeIds.includes('claude-ollama'));
    expect(claude.connectionAction).toBe('clone');
    expect(claude.connection.credentials.ANTHROPIC_AUTH_TOKEN).toBe('example-other-token');
  });

  it('detaches a route that stopped declaring an endpoint at all', () => {
    // `Absent` must not collapse into `matches anything`: a record with no
    // endpoint describes no backend, so it cannot stay on this one.
    const { providers, graph } = shared();
    delete providers.find((provider) => provider.id === 'codex-ollama').envVars.OPENAI_BASE_URL;

    const plan = planGraphReconciliation(graph, providers, { mintId: minter('new') });
    const codex = plan.regroups.find((regroup) => regroup.routeIds.includes('codex-ollama'));
    expect(codex.connectionAction).toBe('clone');
    expect(codex.connection.transports).toEqual({});
  });
});

describe('a mode-only legacy edit stays route-scoped', () => {
  it('changes no connection-owned value and plans no graph change', () => {
    const providers = providersFixture();
    const { graph } = imported(providers);
    // Exactly the shape of an old client's PATCH on the mode editor.
    Object.assign(providers.find((p) => p.id === 'claude-ollama'), {
      timeout: 120000,
      args: ['--verbose'],
      defaultModel: 'example-model:70b',
    });

    expect(connectionOwnedSnapshot(providers.find((p) => p.id === 'claude-ollama')))
      .toEqual(graph.routes.find((route) => route.providerId === 'claude-ollama').projected);
    expect(reconciliationIsNoop(planGraphReconciliation(graph, providers, { mintId: minter('new') }))).toBe(true);
  });
});

describe('graphFromPreview', () => {
  it('proposes a graph the database uniqueness rules would accept', () => {
    // The preview already refuses to emit a violating graph; this pins that the
    // ROW mapping preserves it, since the DB indexes are the real enforcement.
    const preview = buildProviderGraphPreview({ providers: providersFixture() });
    const graph = graphFromPreview(preview, minter());
    const bindingModes = graph.routes.map((route) => `${route.bindingId}|${route.mode}`);
    expect(new Set(bindingModes).size).toBe(bindingModes.length);
    const variants = graph.bindings.map((binding) =>
      `${binding.connectionId}|${binding.harnessId ?? ''}|${binding.variantKey}`);
    expect(new Set(variants).size).toBe(variants.length);
  });
});
