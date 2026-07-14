/**
 * SSRF / key-exfiltration guard for provider `endpoint` URLs.
 *
 * Provider `endpoint` is a free-form URL the user types. Model-refresh and
 * API-run paths attach the provider's `Authorization: Bearer <apiKey>` (a
 * paid/quota-billed LLM key) and `fetch` that host. A hostile or mistyped
 * endpoint could therefore receive the user's paid API key and prompts, or be
 * pointed at a cloud metadata service (169.254.169.254) to exfiltrate instance
 * credentials — classic SSRF.
 *
 * The guard is intentionally scoped to **secret-bearing** requests only. A
 * local LLM (Ollama / LM Studio) with no API key is never restricted, so the
 * loopback local-LLM story is unaffected. When a key IS attached we require the
 * destination to be one of:
 *   - loopback (localhost / 127.0.0.0/8 / ::1)
 *   - a private / link-local / CGNAT (Tailscale) range — the user's own LAN,
 *     where self-hosted LLM servers legitimately live on this Tailscale-only,
 *     single-user product
 *   - a known paid-LLM provider host (the built-in allowlist)
 *   - an arbitrary host the user has *explicitly* opted into via the provider's
 *     `allowCustomEndpoint` flag
 *
 * Cloud-metadata endpoints are ALWAYS blocked, even with `allowCustomEndpoint`
 * — a bearer token has no business going there and it's the canonical SSRF
 * credential-theft target.
 *
 * Kept in `aiToolkit/internal/` (pure, no imports) so the toolkit stays
 * self-contained; `server/lib/aiProvider.js` imports it from here too.
 *
 * NOTE: checks are performed on the URL's literal host. We do not resolve DNS,
 * so a user-supplied hostname that resolves to a private/metadata IP is treated
 * as the user's own choice (they typed it) rather than defended against — this
 * matches PortOS's single-user private-network trust model. The metadata and
 * private-range literals below still block the direct-IP SSRF vector.
 */

// Cloud-metadata hosts that must NEVER receive a bearer token (IMDS credential
// theft is the classic SSRF payoff). Blocked regardless of opt-in.
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / Azure / GCP / OpenStack / DigitalOcean IMDS (IPv4)
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254', // AWS IMDS (IPv6)
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

// Known paid / quota-billed LLM provider hosts — safe to receive their own key.
const ALLOWED_PROVIDER_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.x.ai',
  'api.together.xyz',
  'api.together.ai',
  'openrouter.ai',
  'api.openrouter.ai',
  'api.perplexity.ai',
  'api.cohere.ai',
  'api.cohere.com',
  'api.fireworks.ai',
]);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:127.0.0.1`) down to the v4 literal. */
function unwrapMappedV4(host) {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  return m ? m[1] : host;
}

function isLoopbackOrPrivateV4(host) {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255) || a > 255) return false;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0 — treated as local
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata IP blocked earlier)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
  return false;
}

function isLoopbackOrPrivateV6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return true; // loopback
  if (h === '::') return true; // unspecified — local
  if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  return false;
}

function isLocalHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = unwrapMappedV4(host);
  return isLoopbackOrPrivateV4(v4) || isLoopbackOrPrivateV6(host);
}

/**
 * Decide whether it's safe to attach a secret (API key) to a request to
 * `endpoint`. Pure — returns `{ allowed, reason }` and never throws.
 *
 * @param {string} endpoint - the provider endpoint URL
 * @param {object} [opts]
 * @param {boolean} [opts.allowCustomEndpoint] - user explicitly opted this
 *   provider into sending secrets to an arbitrary (non-local, non-allowlisted)
 *   host.
 */
export function evaluateSecretEndpoint(endpoint, { allowCustomEndpoint = false } = {}) {
  if (!endpoint || typeof endpoint !== 'string') {
    return { allowed: false, reason: 'missing endpoint URL' };
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { allowed: false, reason: `invalid endpoint URL: ${endpoint}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `unsupported protocol: ${url.protocol}` };
  }

  // WHATWG URL keeps brackets on IPv6 literals (`[::1]`); strip them so the
  // host compares/regexes below see the bare address.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Metadata hosts are blocked unconditionally — even with opt-in.
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(unwrapMappedV4(host))) {
    return { allowed: false, reason: `cloud-metadata endpoint blocked: ${host}` };
  }

  if (isLocalHost(host)) return { allowed: true, reason: null };
  if (ALLOWED_PROVIDER_HOSTS.has(host)) return { allowed: true, reason: null };
  if (allowCustomEndpoint) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason:
      `refusing to send API key to non-allowlisted host "${host}". ` +
      'Enable "allow custom endpoint" on this provider to opt in.',
  };
}

/**
 * Throwing convenience wrapper for call sites that already return/propagate an
 * Error. Only enforces when a secret is actually being attached (`hasSecret`),
 * so keyless local-LLM calls are never blocked.
 */
export function assertSecretEndpoint(endpoint, { hasSecret, allowCustomEndpoint } = {}) {
  if (!hasSecret) return;
  const { allowed, reason } = evaluateSecretEndpoint(endpoint, { allowCustomEndpoint });
  if (!allowed) {
    throw new Error(`Blocked outbound API-key request: ${reason}`);
  }
}
