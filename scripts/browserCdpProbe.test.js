import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { probeCdpVersion } from '../browser/cdpProbe.js';

let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

it('bounds a stalled CDP body while preserving valid and malformed endpoint handling', async () => {
  let stalledBodySent = false;
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/valid') res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://example.test/devtools/browser/fixture' }));
    else if (req.url === '/malformed') res.end('<html>not CDP</html>');
    else if (req.url === '/other') res.end(JSON.stringify({ service: 'other' }));
    else {
      res.flushHeaders();
      res.write('{"webSocketDebuggerUrl":');
      stalledBodySent = true; // Headers/body began; the fixture never finishes it.
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  expect(await probeCdpVersion(`${base}/valid`)).toEqual({ webSocketDebuggerUrl: 'ws://example.test/devtools/browser/fixture' });
  expect(await probeCdpVersion(`${base}/malformed`)).toBeNull();
  expect(await probeCdpVersion(`${base}/other`)).toBeNull();
  expect(await probeCdpVersion(`${base}/stalled`)).toBeNull();
  expect(stalledBodySent).toBe(true);
});
