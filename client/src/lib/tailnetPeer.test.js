// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { isTailnetPeer } from './tailnetPeer.js';

// The table below is `server/lib/tailnetPeer.test.js`, case for case. Keeping
// them identical is the whole point of the port: the previous inline copy in
// UnattendedRenderRouting had no table of its own and had already drifted.
describe('isTailnetPeer (client port)', () => {
  it('accepts a MagicDNS host', () => {
    expect(isTailnetPeer({ host: 'example-host.tailnet-example.ts.net' })).toBe(true);
    expect(isTailnetPeer({ host: '  example-host.tailnet-example.ts.net  ' })).toBe(true);
  });

  it('accepts a Tailscale CGNAT v4 address across the whole 100.64.0.0/10 range', () => {
    for (const address of ['100.64.0.1', '100.64.0.5', '100.127.255.254']) {
      expect(isTailnetPeer({ address })).toBe(true);
    }
  });

  it('rejects 100.x addresses OUTSIDE the CGNAT range, which are ordinary public space', () => {
    for (const address of ['100.63.0.1', '100.128.0.1', '100.255.255.1']) {
      expect(isTailnetPeer({ address })).toBe(false);
    }
  });

  it('accepts the Tailscale IPv6 ULA, bracketed or bare', () => {
    expect(isTailnetPeer({ address: 'fd7a:115c:a1e0::1' })).toBe(true);
    expect(isTailnetPeer({ address: '[fd7a:115c:a1e0::1]' })).toBe(true);
  });

  it('rejects a plain LAN address, a public host, and a lookalike suffix', () => {
    for (const address of ['192.0.2.10', '10.0.0.5', 'example.com', 'notreally-ts.net.example.com']) {
      expect(isTailnetPeer({ address })).toBe(false);
    }
  });

  // `host` is what the server actually dials, so a tailnet-looking address must
  // not rescue a peer configured to reach a non-tailnet hostname.
  it('lets an explicit non-tailnet host override a tailnet-looking address', () => {
    expect(isTailnetPeer({ host: 'render.example.com', address: '100.64.0.1' })).toBe(false);
  });

  it('fails closed on missing, empty, or malformed input', () => {
    for (const peer of [undefined, null, {}, { host: '   ' }, { address: '' }, { address: '100.64.0' }, { address: '100.999.0.1' }]) {
      expect(isTailnetPeer(peer)).toBe(false);
    }
  });

  // The exact divergence the inline copy shipped: it range-checked only the
  // SECOND octet, so a malformed address inside 100.64/10 read as tailnet in
  // the browser while the server called it public space.
  it('rejects a malformed address whose leading octets look like CGNAT', () => {
    for (const address of ['100.64.999.1', '100.127.0.999']) {
      expect(isTailnetPeer({ address })).toBe(false);
    }
  });
});
