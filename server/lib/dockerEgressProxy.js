/**
 * The install phase's egress proxy (#12844): a Node builtins-only HTTPS
 * CONNECT proxy that runs inside its own hardened container, the only member
 * of a run's internal Docker network besides the install container. It allows
 * a tunnel only when the target is an allowlisted host name on an allowed
 * port and every address it resolves to is public — so an allowlisted name
 * pointed at the host gateway, a LAN or tailnet address, or loopback is still
 * refused. Plain-HTTP proxying is refused outright.
 *
 * `DOCKER_EGRESS_PROXY_SOURCE` is the program the container runs with
 * `node -e`; it is assembled from the functions below so the allow decision a
 * test exercises is the one the container executes.
 */

/** True when `address` (IPv4 or IPv6 literal) is not publicly routable. */
function isNonPublicAddress(address) {
  const text = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  const v4 = mapped ? mapped[1] : text;
  const octets = v4.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (!text.includes(':')) return true;
  return text === '::' || text === '::1'
    || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || /^ff/.test(text)
    || /^64:ff9b:/.test(text) || /^2001:db8:/.test(text) || /^::ffff:/.test(text);
}

/**
 * Parse a CONNECT authority (`host:port`) and decide it against the
 * allowlist. Returns `{ host, port }` when allowed, else `{ refused }`.
 */
function decideEgressConnect(authority, { allow, ports }) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(authority ?? '').trim());
  if (!match) return { refused: 'malformed or IP-literal CONNECT target' };
  const host = match[1].toLowerCase().replace(/\.$/, '');
  const port = Number(match[2]);
  if (/^[\d.]+$/.test(host)) return { refused: 'IP-literal targets are not allowed' };
  if (!ports.includes(port)) return { refused: `port ${port} is not allowed` };
  if (!allow.includes(host)) return { refused: `${host} is not on the egress allowlist` };
  return { host, port };
}

// Runs inside the proxy container; builtins come from getBuiltinModule so the
// same text works under `node -e` (CommonJS) and in this ESM module.
function egressProxyMain(env) {
  const net = process.getBuiltinModule('node:net');
  const http = process.getBuiltinModule('node:http');
  const dns = process.getBuiltinModule('node:dns');
  const allow = String(env.PORTOS_EGRESS_ALLOW || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const ports = String(env.PORTOS_EGRESS_PORTS || '443').split(',').map(Number).filter(Number.isInteger);
  const listenPort = Number(env.PORTOS_EGRESS_PORT ?? 3128);
  const listenHost = env.PORTOS_EGRESS_LISTEN || '0.0.0.0';
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('portos egress proxy: only HTTPS CONNECT tunnels are allowed\n');
  });
  server.on('connect', (req, client, head) => {
    client.on('error', () => {});
    const refuse = (reason) => {
      console.warn(`⛔ egress refused ${req.url}: ${reason}`);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${reason}\n`);
    };
    const decision = decideEgressConnect(req.url, { allow, ports });
    if (decision.refused) return refuse(decision.refused);
    dns.lookup(decision.host, { all: true }, (error, addresses) => {
      if (error || !addresses?.length) return refuse(`${decision.host} did not resolve`);
      if (addresses.some(({ address }) => isNonPublicAddress(address))) return refuse(`${decision.host} resolves to a non-public address`);
      const upstream = net.connect({ host: addresses[0].address, port: decision.port }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  server.listen(listenPort, listenHost, () => console.log(`🛡️ portos-egress-proxy ready on ${server.address().port} for ${allow.join(',')}`));
}

/** Test hook: the allow decisions the proxy program embeds. */
export const __egressProxyPolicy = Object.freeze({ isNonPublicAddress, decideEgressConnect });

/** The marker line the executor waits for before starting the install container. */
export const DOCKER_EGRESS_PROXY_READY = 'portos-egress-proxy ready';

export const DOCKER_EGRESS_PROXY_SOURCE = [
  `const isNonPublicAddress = ${isNonPublicAddress.toString()};`,
  `const decideEgressConnect = ${decideEgressConnect.toString()};`,
  `(${egressProxyMain.toString()})(process.env);`,
].join('\n');
