import { describe, it, expect } from 'vitest';
import {
  blocksRouting,
  describeMissingPrerequisites,
  isPrivateNetworkEndpoint,
  providerPrerequisites,
  providerRuntimeKey,
  ROUTING_BLOCKING_CODES,
} from './providerPrerequisites.js';

const cli = (over = {}) => ({ id: 'codex', type: 'cli', command: 'codex', ...over });
const api = (over = {}) => ({ id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1', ...over });

describe('providerRuntimeKey', () => {
  it('normalizes a bare process-provider command to its binary name', () => {
    expect(providerRuntimeKey(cli({ command: 'Codex.exe' }))).toBe('codex');
    expect(providerRuntimeKey({ type: 'tui', command: '  agy  ' })).toBe('agy');
  });

  // The runtime table only ever answered "does the BARE binary resolve on
  // PortOS's PATH?". The runner spawns an explicitly-pathed command against the
  // provider's own env, so lending it the bare binary's verdict would report a
  // working CLI as missing.
  it('is null for a command carrying an explicit path', () => {
    expect(providerRuntimeKey(cli({ command: '/opt/example/bin/codex' }))).toBeNull();
    expect(providerRuntimeKey(cli({ command: './codex' }))).toBeNull();
    expect(providerRuntimeKey(cli({ command: 'C:\\tools\\codex.exe' }))).toBeNull();
  });

  // Same reasoning: the runner resolves such a provider against ITS PATH, not
  // the one the table scanned.
  it('is null for a provider carrying its own PATH', () => {
    expect(providerRuntimeKey(cli({ envVars: { PATH: '/opt/example/bin' } }))).toBeNull();
    expect(providerRuntimeKey(cli({ envVars: { path: '/opt/example/bin' } }))).toBeNull();
    expect(providerRuntimeKey(cli({ envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } }))).toBe('codex');
  });

  it('is null for a provider with no spawned command', () => {
    expect(providerRuntimeKey(api())).toBeNull();
    expect(providerRuntimeKey(cli({ command: '' }))).toBeNull();
    expect(providerRuntimeKey(cli({ command: '   ' }))).toBeNull();
    expect(providerRuntimeKey(null)).toBeNull();
  });
});

describe('isPrivateNetworkEndpoint', () => {
  it.each([
    'http://localhost:1234/v1',
    'http://127.0.0.2:11434',
    'http://[::1]:1234',
    'http://10.0.0.4:1234/v1',
    'http://192.168.1.5:1234/v1',
    'http://172.16.3.4:1234',
    'http://100.64.0.5:11434',            // Tailscale CGNAT
    'http://[fd7a:115c:a1e0::1]:11434',   // Tailscale ULA
    'http://[fe80::1]:11434',             // link-local
    'http://desk.ts.net:11434',
    'http://nas.local:1234',
    'nas:11434',                          // single-label host, no scheme
  ])('treats %s as private', (endpoint) => {
    expect(isPrivateNetworkEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://api.example.com/v1',
    'http://192.0.2.10:1234/v1',   // TEST-NET-1 is routable, not private
    'http://fdrive.example.com',   // must not match the fc00::/7 hextet rule by prefix
    'http://[fd::1]:11434',        // leading hextet 0x00fd is NOT in fc00::/7
    'https://10.evil.example',     // a DNS name that merely STARTS like RFC1918
    'https://172.16.evil.example',
    'https://100.64.evil.example',
    '',
    'not a url at all ::::',
  ])('treats %s as NOT private', (endpoint) => {
    expect(isPrivateNetworkEndpoint(endpoint)).toBe(false);
  });

  // The two documented places this parser and the client's cheap regex read a
  // host differently. Pinned so a future edit to either has to decide about
  // them rather than flip one by accident.
  it('expands a compact loopback form the client regex misses', () => {
    expect(isPrivateNetworkEndpoint('http://127.1:11434')).toBe(true);
  });

  it('rejects an IPv6 literal without brackets, which no client can connect to anyway', () => {
    expect(isPrivateNetworkEndpoint('http://::1:11434')).toBe(false);
  });
});

describe('providerPrerequisites', () => {
  it('reports a CLI whose binary is absent', () => {
    const result = providerPrerequisites(cli(), { runtime: { installed: false, label: 'Codex CLI' } });
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ code: 'runtime', label: 'Codex CLI is not installed' }]);
  });

  it('treats an UNPROBED runtime as met, never as missing', () => {
    expect(providerPrerequisites(cli(), { runtime: null }).met).toBe(true);
    expect(providerPrerequisites(cli()).met).toBe(true);
    expect(providerPrerequisites(cli(), { runtime: { installed: true, label: 'Codex CLI' } }).met).toBe(true);
  });

  it('reports a keyless API provider on a PUBLIC endpoint', () => {
    const result = providerPrerequisites(api());
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ code: 'apiKey', label: 'API key is not set' }]);
  });

  it('does not demand a key for a private-network endpoint', () => {
    expect(providerPrerequisites(api({ endpoint: 'http://localhost:1234/v1' })).met).toBe(true);
    expect(providerPrerequisites(api({ endpoint: 'http://desk.ts.net:11434' })).met).toBe(true);
  });

  it('accepts a key from either a raw (apiKey) or a sanitized (hasApiKey) record', () => {
    expect(providerPrerequisites(api({ apiKey: 'sk-example' })).met).toBe(true);
    expect(providerPrerequisites(api({ hasApiKey: true })).met).toBe(true);
    expect(providerPrerequisites(api({ hasApiKey: false })).met).toBe(false);
  });

  it('reports an OrcaRouter wrapper whose sibling holds no key', () => {
    const wrapper = cli({ id: 'opencode-orcarouter', command: 'opencode', orcarouterBacked: true });
    expect(providerPrerequisites(wrapper, { orcaRouterKeySet: false }).missing)
      .toEqual([{ code: 'inheritedApiKey', label: 'OrcaRouter API provider has no API key' }]);
    expect(providerPrerequisites(wrapper, { orcaRouterKeySet: true }).met).toBe(true);
    // null = cannot tell, which must never read as missing
    expect(providerPrerequisites(wrapper, { orcaRouterKeySet: null }).met).toBe(true);
  });

  it('collects every finding rather than stopping at the first', () => {
    const wrapper = { id: 'x', type: 'api', endpoint: 'https://api.example.com', orcarouterBacked: true };
    const result = providerPrerequisites(wrapper, {
      runtime: { installed: false, label: 'OpenCode CLI' },
      orcaRouterKeySet: false,
    });
    expect(result.missing.map((m) => m.code)).toEqual(['runtime', 'apiKey', 'inheritedApiKey']);
  });
});

describe('describeMissingPrerequisites', () => {
  it('joins the labels, and is null when nothing is missing', () => {
    expect(describeMissingPrerequisites([{ code: 'a', label: 'One' }, { code: 'b', label: 'Two' }]))
      .toBe('One; Two');
    expect(describeMissingPrerequisites([])).toBeNull();
    expect(describeMissingPrerequisites(undefined)).toBeNull();
  });
});

// Routing may act on strictly less than the card displays: a missing BINARY is
// unarguable, a missing stored key is not (a secret env var can supply it —
// issue #4612), so only the former may take a provider out of the chain.
describe('blocksRouting', () => {
  it('acts on a missing runtime', () => {
    expect(blocksRouting(providerPrerequisites(cli(), { runtime: { installed: false, label: 'Codex CLI' } }).missing)).toBe(true);
  });

  it('does NOT act on the credential findings', () => {
    expect(blocksRouting(providerPrerequisites(api()).missing)).toBe(false);
    const wrapper = cli({ orcarouterBacked: true });
    expect(blocksRouting(providerPrerequisites(wrapper, { orcaRouterKeySet: false }).missing)).toBe(false);
  });

  it('is false for nothing missing, and for a non-array', () => {
    expect(blocksRouting([])).toBe(false);
    expect(blocksRouting(undefined)).toBe(false);
  });

  it('pins the routing-blocking set so widening it is a deliberate edit', () => {
    expect([...ROUTING_BLOCKING_CODES]).toEqual(['runtime']);
  });
});
