// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../../lib/portosAuthCore.js';

describe('Vite API proxy host-control provenance', () => {
  it.each(['192.0.2.10', '127.0.0.1', '::1', undefined])(
    'replaces caller headers with its own socket observation %s', remoteAddress => {
      const config = viteConfig({ command: 'serve', mode: 'test' });
      const proxy = new EventEmitter();
      config.server.proxy['^/api(?:/|$)'].configure(proxy);
      // Model the outbound request after the proxy copied incoming headers.
      const headers = { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: ['127.0.0.1', '::1'] };
      proxy.emit('proxyReq', {
        setHeader: (name, value) => { headers[name] = value; },
      }, {
        socket: { remoteAddress },
        headers: { ...headers, 'x-forwarded-for': '127.0.0.1', origin: 'http://localhost' },
      });
      expect(headers[DEV_PROXY_CLIENT_ADDRESS_HEADER]).toBe(remoteAddress || 'unknown');
    },
  );
});
