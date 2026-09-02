import https from 'node:https';
import { once } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCMRqOF3tCYr36v
AFcTYZ6WjPMPbrqc2KSrJ2oWnc12kHu/XQuE9z6fQgpbOgQzNsMJ4QXz2iAcxCd3
laBp6pIg/WC3xrThJyrX7W2/8mxv3hY7/5jAwDOmAHm+fux+0HnO//qA5HR8c5gr
WWW1LWqaN5dlazYVazAY0vlg9sA57cgA+HeZsyxzVQ4UUL69OnJpd5Ge1OU3qG4t
5xNkTWBRj7PVmj/3BJ+ePjKW3aJ4seXR9B4DziceEGAGcDqQn/N9XRjLG0P4VqT2
WNhqTLskBoBBJQLgZVyo7/sjTnZtPMbEMKtMzkOHjBsc7RzXd1sNXEJO4ExyBfCD
qxr1lCFHAgMBAAECggEAJCbIWeX0qIUCByP1TP9pma81rRKCcY270ohT5QRCQX43
Bjh6kYgO0Yh5ls0669//H/qoSBI9GGzNJxqevu0/P9VNKc/CKgyoFAISuNdHbwUz
gb77pSFjrjKNLbUUShJ8cgayjqlSBAjefL2LYsgToy8Ui4S36Yk4Wg11S7IMFGF7
5i9Ai6Z6LKuQ/R/Kfrqpn1bXCabGjD1RaBfuNP9LCnn/J+NTMCY/0Wfff1P9t3XU
jiqg/ZTpxPSckv+Scp/c0WpjZG55WjuSZYNshkas9JyXFp6sWp5Bmo8ffGq0Pa2p
YRf9pxyfAi58HYecZS/CQKgTwWE3+Busc99ZL1pOwQKBgQDCjInHMz51Tej9cxZB
5NYRneqnvYXiMyWaCXaADuonadymImigXf3EduQbkPDMig43wcQUrASAIACmQLWB
yjRaqvkRYzJ8e4mXiPopPUi21a1Z8ifC82TH3suyF3haycy5aw/q0isZ6hipFdx4
Lf6k/mJKisA5z+4cAQCDoHcyUQKBgQC4lYSBAY5dEQZeCm+SqdAEXkrialwx/RYR
ch0d+Ytbb5xao1zdamHjjk1f8J9Ote3biLKFFKTkOnDT8Gizd5mH4yqScV6FdA59
iqAZ0wayMmAgWUTtVNkb+g6Mtq6ZX88hZ4lafJqFdCQUU9LdZbfFuXTLB/utAFBT
l7zLMFHcFwKBgFvHOvQrW4qxP3nZgiWB0+8ppVqOkQt9/34keq+82X/QdBQ35U3K
KX42bDQI82A6vKxXD66E2/apokTMABSDlKE1SRyHxHhvOyCusP0leRkvwoDNOS7B
7chQdZ3FbrS9wIO0WyT3Evg9tHaH5qMXZ6rkivAJdtePHRA+9MQjvjeRAoGAWHRe
USwbuwGjmYFKwm/aHZ3KKQJrOBFed/HFfk3NuH2d4dmTcQ+/5TqWXbmDvkZ0u9Wg
JyIjerN+yjHVGtvfmT0Fc7QcZbueDg9Wdcmo1dBKPHZLD6iveja0rj4FIb7GFe31
5oT7z6Q+ffdFf491J62eCIXE17zkwYpfkMeREvUCgYBSSkcsK7cKfFk5AGtkBLhk
oxttdKfVg0vFVWzBzBxLHvQA4o4jiwkGpuVVvjXu/kyPECXlQPE/ov3KALZM5zOx
2DqP/WjHtbiHnF/KKLgB05EOQ2w8v136DUAZo+2vPae6qbCriVqgWJCPvMmSv0Vd
OOM7V7pTVPZ25wsq890JHA==
-----END PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUZS+lbXJ33clMlTqD72cvx5MATncwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgyNzIyMTE1NFoXDTI2MDgy
ODIyMTE1NFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAjEajhd7QmK9+rwBXE2GelozzD266nNikqydqFp3NdpB7
v10LhPc+n0IKWzoEMzbDCeEF89ogHMQnd5WgaeqSIP1gt8a04Scq1+1tv/Jsb94W
O/+YwMAzpgB5vn7sftB5zv/6gOR0fHOYK1lltS1qmjeXZWs2FWswGNL5YPbAOe3I
APh3mbMsc1UOFFC+vTpyaXeRntTlN6huLecTZE1gUY+z1Zo/9wSfnj4ylt2ieLHl
0fQeA84nHhBgBnA6kJ/zfV0YyxtD+Fak9ljYaky7JAaAQSUC4GVcqO/7I052bTzG
xDCrTM5Dh4wbHO0c13dbDVxCTuBMcgXwg6sa9ZQhRwIDAQABo1MwUTAdBgNVHQ4E
FgQUI+VmqRYCSzZNeHcFeDmtfPX4iB8wHwYDVR0jBBgwFoAUI+VmqRYCSzZNeHcF
eDmtfPX4iB8wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAWyx/
6dpl9inGayqrKfF3ebQufZY2WuyrvwgkpiUxxvfMvNqW3/5Z45P04nW5ak7c0XDt
dDnk161hhdTAthlMYZ3QAH9B/ci/MAQonZea+99uvpvh+ZGjtCfGz1G37nVlkpxG
i1W4yugRDUmrAGfdNQ3wR9v/6UyHPpCCpHEl4kB3N/VIbL5Y/qxp+4SQ/8GIzQqP
JVoZZQTvSh8yoO+74Ufek3gUFyw0O9tNUA0tZYi1Q877xfGR+Pvlmr9LI0Jo3t+8
kJJ4iMeCChtH6zskbIb+DHp8ujyRLti/3DAtw+yabyM/UJi3fasx3o7595D72GXL
w8Rk6+1aiIlGaeWIiQ==
-----END CERTIFICATE-----`;

async function startHttpsServer(handler) {
  const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `https://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// peerFetch resolves this install's federation identity through a dynamic
// import of the instances service; stub it so the header assertions don't
// depend on (or create) a real instance identity on disk.
let selfInstanceId = 'self-instance-id';
vi.mock('../services/instances.js', () => ({
  getInstanceId: async () => selfInstanceId,
  UNKNOWN_INSTANCE_ID: 'unknown',
}));

import {
  peerSocketOptions,
  peerSocketOptionsFor,
  peerFetch,
  peerAuthHeaders,
  __resetSelfInstanceIdForTests,
} from './peerHttpClient.js';
import { RESPONSE_TOO_LARGE } from './httpClient.js';

describe('peerHttpClient', () => {
  it('peerSocketOptions disables cert validation for Socket.IO peer connections', () => {
    expect(peerSocketOptions.rejectUnauthorized).toBe(false);
    expect(peerSocketOptions.transports).toContain('websocket');
  });

  it('peerFetch falls through to global fetch for http:// URLs', async () => {
    await expect(peerFetch('http://127.0.0.1:1/should-not-exist', {
      signal: AbortSignal.timeout(50)
    })).rejects.toBeDefined();
  });

  describe('peerFetch headers', () => {
    const realFetch = globalThis.fetch;
    let calls;

    beforeEach(() => {
      selfInstanceId = 'self-instance-id';
      __resetSelfInstanceIdForTests();
      calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
      };
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      __resetSelfInstanceIdForTests();
    });

    it('identifies this install with X-PortOS-Instance-Id on every hop', async () => {
      await peerFetch('http://peer.example/api/peer-sync/record');
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('self-instance-id');
    });

    it('sends the instance id alongside the peer Basic credential', async () => {
      await peerFetch('http://peer.example/api/peer-sync/record', {}, { auth: { username: 'alice', password: 'pw' } });
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('self-instance-id');
      expect(calls[0].options.headers.Authorization).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`);
    });

    it('lets explicit caller headers win', async () => {
      await peerFetch('http://peer.example/x', { headers: { 'X-PortOS-Instance-Id': 'explicit' } });
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('explicit');
    });

    it('does not send the header twice when the caller overrides it in another casing', async () => {
      await peerFetch('http://peer.example/x', { headers: { 'x-portos-instance-id': 'explicit' } });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'x-portos-instance-id');
      expect(sent).toEqual(['x-portos-instance-id']);
      expect(calls[0].options.headers['x-portos-instance-id']).toBe('explicit');
    });

    it('does not send the Basic credential twice when the caller sets its own', async () => {
      await peerFetch('http://peer.example/x', { headers: { authorization: 'Bearer t' } }, { auth: { password: 'pw' } });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'authorization');
      expect(sent).toEqual(['authorization']);
    });

    it('preserves a Headers instance while dropping the overridden Basic credential', async () => {
      await peerFetch('http://peer.example/x', {
        headers: new Headers({ Authorization: 'Bearer t', 'X-Request-Id': 'request-1' }),
      }, { auth: { password: 'pw' } });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'authorization');
      expect(sent).toEqual(['authorization']);
      expect(calls[0].options.headers.authorization).toBe('Bearer t');
      expect(calls[0].options.headers['x-request-id']).toBe('request-1');
    });

    it('preserves Map headers while dropping overridden injected headers', async () => {
      await peerFetch('http://peer.example/x', {
        headers: new Map([['x-portos-instance-id', 'explicit'], ['X-Request-Id', 'request-1']]),
      });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'x-portos-instance-id');
      expect(sent).toEqual(['x-portos-instance-id']);
      expect(calls[0].options.headers['x-portos-instance-id']).toBe('explicit');
      expect(calls[0].options.headers['x-request-id']).toBe('request-1');
    });

    it('preserves duplicate values from iterable header pairs', async () => {
      await peerFetch('http://peer.example/x', {
        headers: [['Accept', 'application/json'], ['Accept', 'text/plain']],
      });
      expect(calls[0].options.headers.accept).toBe('application/json, text/plain');
    });

    it('omits the header entirely when this install has no identity yet', async () => {
      selfInstanceId = 'unknown';
      __resetSelfInstanceIdForTests();
      await peerFetch('http://peer.example/x');
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBeUndefined();
    });
  });

  describe('peerFetch over HTTPS', () => {
    let fixture;

    beforeEach(() => {
      selfInstanceId = 'self-instance-id';
      __resetSelfInstanceIdForTests();
    });

    afterEach(async () => {
      if (fixture) await fixture.close();
      fixture = null;
      __resetSelfInstanceIdForTests();
    });

    it('destroys an unbounded response stream after it exceeds maxBytes', async () => {
      let responseClosed;
      const responseClosedPromise = new Promise((resolve) => { responseClosed = resolve; });
      fixture = await startHttpsServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(16));
        res.once('close', responseClosed);
      });

      // Assert the machine-readable code, not just the prose: peer-sync's
      // record and asset pullers discriminate an oversize response from a dead
      // peer on err.code, so a reworded message must not silently reclassify
      // the failure as `peer-unreachable` (#5662).
      await expect(peerFetch(`${fixture.url}/stream`, { maxBytes: 8 }))
        .rejects.toMatchObject({
          code: RESPONSE_TOO_LARGE,
          message: expect.stringContaining('Response body exceeded maxBytes 8'),
        });
      await responseClosedPromise;
    });

    it('rejects an oversized declared Content-Length before the body begins streaming', async () => {
      let bodyStarted = false;
      let responseClosed;
      const responseClosedPromise = new Promise((resolve) => { responseClosed = resolve; });
      fixture = await startHttpsServer((_req, res) => {
        res.writeHead(200, { 'content-length': '1024' });
        res.flushHeaders();
        const timer = setTimeout(() => {
          bodyStarted = true;
          res.end(Buffer.alloc(1024));
        }, 50);
        res.once('close', () => {
          clearTimeout(timer);
          responseClosed();
        });
      });

      await expect(peerFetch(`${fixture.url}/declared-size`, { maxBytes: 32 }))
        .rejects.toMatchObject({
          code: RESPONSE_TOO_LARGE,
          message: expect.stringContaining('Response declared Content-Length 1024 exceeds maxBytes 32'),
        });
      await responseClosedPromise;
      expect(bodyStarted).toBe(false);
    });

    it.each([
      ['Headers', new Headers([['x-portos-instance-id', 'headers-id'], ['authorization', 'Bearer headers']])],
      ['Map', new Map([['x-portos-instance-id', 'map-id'], ['authorization', 'Bearer map']])],
    ])('deduplicates injected headers for mixed-case %s input over TLS', async (_kind, headers) => {
      let receivedHeaders;
      fixture = await startHttpsServer((req, res) => {
        receivedHeaders = req.rawHeaders;
        res.end('ok');
      });

      const response = await peerFetch(`${fixture.url}/headers`, { headers }, { auth: { password: 'peer-password' } });
      expect(await response.text()).toBe('ok');

      const headerPairs = receivedHeaders.reduce((pairs, header, index) => (
        index % 2 === 0 ? [...pairs, [header, receivedHeaders[index + 1]]] : pairs
      ), []);
      const valuesFor = (name) => headerPairs
        .filter(([header]) => header.toLowerCase() === name)
        .map(([, value]) => value);
      expect(valuesFor('x-portos-instance-id')).toEqual([headers instanceof Map ? 'map-id' : 'headers-id']);
      expect(valuesFor('authorization')).toEqual([headers instanceof Map ? 'Bearer map' : 'Bearer headers']);
    });

    it('rejects an aborted TLS request without an unhandled rejection', async () => {
      let requestAborted;
      const requestAbortedPromise = new Promise((resolve) => { requestAborted = resolve; });
      let requestStarted;
      const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
      fixture = await startHttpsServer((req, res) => {
        req.once('aborted', requestAborted);
        requestStarted();
        res.writeHead(200, { 'content-type': 'text/plain' });
      });
      const unhandled = [];
      const recordUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', recordUnhandled);
      const controller = new AbortController();

      try {
        const request = peerFetch(`${fixture.url}/slow`, { signal: controller.signal });
        await requestStartedPromise;
        controller.abort();
        await expect(request)
          .rejects.toThrow('Request aborted');
        await requestAbortedPromise;
        await wait(10);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', recordUnhandled);
      }
    });
  });

  describe('peerAuthHeaders', () => {
    it('returns an empty object when the peer has no credential', () => {
      expect(peerAuthHeaders(null)).toEqual({});
      expect(peerAuthHeaders({})).toEqual({});
      expect(peerAuthHeaders({ auth: null })).toEqual({});
      expect(peerAuthHeaders({ auth: { username: '', password: '' } })).toEqual({});
    });

    it('builds a Basic header from username + password', () => {
      const headers = peerAuthHeaders({ auth: { username: 'alice', password: 's3cret' } });
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    });

    it('supports a password-only credential (empty username)', () => {
      const headers = peerAuthHeaders({ auth: { password: 'p@ss' } });
      expect(headers.Authorization).toBe(`Basic ${Buffer.from(':p@ss').toString('base64')}`);
    });
  });

  describe('peerSocketOptionsFor', () => {
    it('returns the bare options object when no credential is set', () => {
      expect(peerSocketOptionsFor({})).toBe(peerSocketOptions);
    });

    it('injects extraHeaders with the Basic credential when present', () => {
      const opts = peerSocketOptionsFor({ auth: { username: 'bob', password: 'pw' } });
      expect(opts.rejectUnauthorized).toBe(false);
      expect(opts.extraHeaders.Authorization).toBe(`Basic ${Buffer.from('bob:pw').toString('base64')}`);
    });
  });
});
