import { describe, it, expect } from 'vitest';
import { evaluateSecretEndpoint, assertSecretEndpoint } from './endpointGuard.js';

describe('endpointGuard — evaluateSecretEndpoint', () => {
  describe('loopback / local endpoints (local LLM story stays supported)', () => {
    it('allows localhost', () => {
      expect(evaluateSecretEndpoint('http://localhost:11434/v1').allowed).toBe(true);
    });
    it('allows 127.0.0.1', () => {
      expect(evaluateSecretEndpoint('http://127.0.0.1:1234/v1').allowed).toBe(true);
    });
    it('allows IPv6 loopback ::1', () => {
      expect(evaluateSecretEndpoint('http://[::1]:11434/v1').allowed).toBe(true);
    });
    it('allows a *.localhost host', () => {
      expect(evaluateSecretEndpoint('http://ollama.localhost/v1').allowed).toBe(true);
    });
  });

  describe('private / LAN / Tailscale ranges (self-hosted LLM on your own network)', () => {
    it('allows 192.168.x.x', () => {
      expect(evaluateSecretEndpoint('http://192.168.1.50:11434/v1').allowed).toBe(true);
    });
    it('allows 10.x.x.x', () => {
      expect(evaluateSecretEndpoint('http://10.0.0.5:1234/v1').allowed).toBe(true);
    });
    it('allows 172.16-31.x.x', () => {
      expect(evaluateSecretEndpoint('http://172.20.1.1:11434/v1').allowed).toBe(true);
      expect(evaluateSecretEndpoint('http://172.15.1.1:11434/v1').allowed).toBe(false);
      expect(evaluateSecretEndpoint('http://172.32.1.1:11434/v1').allowed).toBe(false);
    });
    it('allows CGNAT / Tailscale 100.64.0.0/10', () => {
      expect(evaluateSecretEndpoint('http://100.100.50.1:11434/v1').allowed).toBe(true);
      // ...but not 100.100.100.200 (Alibaba metadata) — see metadata tests
    });
    it('allows fc00::/7 ULA and fe80::/10 link-local IPv6', () => {
      expect(evaluateSecretEndpoint('http://[fd12:3456::1]:11434/v1').allowed).toBe(true);
      expect(evaluateSecretEndpoint('http://[fe80::1]:11434/v1').allowed).toBe(true);
    });
    it('allows IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
      expect(evaluateSecretEndpoint('http://[::ffff:127.0.0.1]:1234/v1').allowed).toBe(true);
    });
  });

  describe('cloud-metadata endpoints are ALWAYS blocked', () => {
    it('blocks 169.254.169.254 (AWS/GCP/Azure IMDS)', () => {
      const r = evaluateSecretEndpoint('http://169.254.169.254/latest/meta-data/');
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/metadata/i);
    });
    it('blocks it even with allowCustomEndpoint opt-in', () => {
      const r = evaluateSecretEndpoint('http://169.254.169.254/latest/', { allowCustomEndpoint: true });
      expect(r.allowed).toBe(false);
    });
    it('blocks metadata.google.internal', () => {
      expect(evaluateSecretEndpoint('http://metadata.google.internal/', { allowCustomEndpoint: true }).allowed).toBe(false);
    });
    it('blocks Alibaba 100.100.100.200', () => {
      expect(evaluateSecretEndpoint('http://100.100.100.200/', { allowCustomEndpoint: true }).allowed).toBe(false);
    });
    it('blocks AWS IPv6 IMDS fd00:ec2::254', () => {
      expect(evaluateSecretEndpoint('http://[fd00:ec2::254]/', { allowCustomEndpoint: true }).allowed).toBe(false);
    });
    it('blocks metadata via decimal/hex IPv4 (URL canonicalizes to 169.254.169.254)', () => {
      expect(evaluateSecretEndpoint('http://2852039166/', { allowCustomEndpoint: true }).allowed).toBe(false);
      expect(evaluateSecretEndpoint('http://0xa9fea9fe/', { allowCustomEndpoint: true }).allowed).toBe(false);
    });
    it('blocks metadata via IPv4-mapped IPv6 (both dotted and hex-compressed forms)', () => {
      expect(evaluateSecretEndpoint('http://[::ffff:169.254.169.254]/', { allowCustomEndpoint: true }).allowed).toBe(false);
      expect(evaluateSecretEndpoint('http://[::ffff:a9fe:a9fe]/', { allowCustomEndpoint: true }).allowed).toBe(false);
    });
  });

  describe('known paid-LLM provider hosts are allowed', () => {
    it('allows api.openai.com', () => {
      expect(evaluateSecretEndpoint('https://api.openai.com/v1').allowed).toBe(true);
    });
    it('allows openrouter.ai', () => {
      expect(evaluateSecretEndpoint('https://openrouter.ai/api/v1').allowed).toBe(true);
    });
    it('allows generativelanguage.googleapis.com', () => {
      expect(evaluateSecretEndpoint('https://generativelanguage.googleapis.com/v1beta').allowed).toBe(true);
    });
    it('allows the bundled NVIDIA NIM host without opt-in', () => {
      expect(evaluateSecretEndpoint('https://integrate.api.nvidia.com/v1').allowed).toBe(true);
    });
  });

  describe('arbitrary public hosts require explicit opt-in', () => {
    it('blocks an unknown public host by default', () => {
      const r = evaluateSecretEndpoint('https://evil.example.com/v1');
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/allow custom endpoint/i);
    });
    it('allows the same host once allowCustomEndpoint is true', () => {
      expect(evaluateSecretEndpoint('https://my-proxy.example.com/v1', { allowCustomEndpoint: true }).allowed).toBe(true);
    });
  });

  describe('malformed / unsupported endpoints', () => {
    it('blocks a non-URL string', () => {
      expect(evaluateSecretEndpoint('not a url').allowed).toBe(false);
    });
    it('blocks a missing endpoint', () => {
      expect(evaluateSecretEndpoint('').allowed).toBe(false);
      expect(evaluateSecretEndpoint(null).allowed).toBe(false);
    });
    it('blocks non-http(s) protocols', () => {
      expect(evaluateSecretEndpoint('file:///etc/passwd').allowed).toBe(false);
      expect(evaluateSecretEndpoint('ftp://api.openai.com/v1').allowed).toBe(false);
    });
  });
});

describe('endpointGuard — assertSecretEndpoint', () => {
  it('does nothing when no secret is attached (keyless local LLM)', () => {
    expect(() => assertSecretEndpoint('https://evil.example.com/v1', { hasSecret: false })).not.toThrow();
  });
  it('throws when a secret would go to a blocked host', () => {
    expect(() => assertSecretEndpoint('https://evil.example.com/v1', { hasSecret: true })).toThrow(/Blocked outbound API-key request/);
  });
  it('does not throw for an allowlisted host with a secret', () => {
    expect(() => assertSecretEndpoint('https://api.openai.com/v1', { hasSecret: true })).not.toThrow();
  });
  it('does not throw for the Cerebras host with a secret', () => {
    expect(() => assertSecretEndpoint('https://api.cerebras.ai/v1', { hasSecret: true })).not.toThrow();
  });
  it('does not throw for loopback with a secret', () => {
    expect(() => assertSecretEndpoint('http://127.0.0.1:1234/v1', { hasSecret: true })).not.toThrow();
  });
  it('throws for a metadata host even with opt-in', () => {
    expect(() => assertSecretEndpoint('http://169.254.169.254/', { hasSecret: true, allowCustomEndpoint: true })).toThrow();
  });
});
