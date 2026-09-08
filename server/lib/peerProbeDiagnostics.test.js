import { describe, expect, it } from 'vitest';
import {
  PROBE_CLASS,
  classifyPeerProbeFailure,
  buildLastProbeRecord,
  formatProbeDiagnosticLog,
} from './peerProbeDiagnostics.js';

describe('classifyPeerProbeFailure', () => {
  const tailcatPeer = { transport: 'tailcat', address: '127.0.0.1', port: 15555 };

  it('marks loopback ECONNREFUSED on a tailcat peer as local_refused', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const result = classifyPeerProbeFailure(err, { peer: tailcatPeer });
    expect(result.class).toBe(PROBE_CLASS.LOCAL_REFUSED);
    expect(result.message).toMatch(/forward is not listening/i);
  });

  it('prefers a live tunnelError over a generic timeout', () => {
    const err = Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const result = classifyPeerProbeFailure(err, {
      peer: tailcatPeer,
      tunnelError: 'dial remote port 5555: context deadline exceeded',
    });
    expect(result.class).toBe(PROBE_CLASS.TUNNEL_DIAL);
    expect(result.message).toMatch(/Tunnel dial failure/);
    expect(result.message).toMatch(/dial remote port 5555/);
  });

  it('classifies HTTP health/details failures as probe_http when the tunnel carried bytes', () => {
    const err = Object.assign(new Error('HTTP 502'), { httpStatus: 502 });
    const result = classifyPeerProbeFailure(err, { peer: tailcatPeer });
    expect(result.class).toBe(PROBE_CLASS.PROBE_HTTP);
    expect(result.message).toMatch(/health\/details/);
    expect(result.httpStatus).toBe(502);
  });

  it('does not invent tunnel_dial for classic peers', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const result = classifyPeerProbeFailure(err, {
      peer: { address: '10.0.0.1', port: 5555 },
    });
    expect(result.class).toBe(PROBE_CLASS.LOCAL_REFUSED);
    expect(result.message).toMatch(/peer not running/);
  });
});

describe('buildLastProbeRecord / formatProbeDiagnosticLog', () => {
  it('records latency and class for a failed probe', () => {
    const last = buildLastProbeRecord({
      ok: false,
      classification: { class: PROBE_CLASS.TUNNEL_DIAL, message: 'Tunnel dial failure — dial remote', httpStatus: null },
      latencyMs: 12.6,
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(last).toMatchObject({
      ok: false,
      class: 'tunnel_dial',
      latencyMs: 13,
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(formatProbeDiagnosticLog(last)).toMatch(/\[tunnel_dial\]/);
  });

  it('records ok probes without a failure message', () => {
    const last = buildLastProbeRecord({ ok: true, latencyMs: 40 });
    expect(last).toMatchObject({ ok: true, class: 'ok', message: null, httpStatus: 200 });
    expect(formatProbeDiagnosticLog(last)).toBe('[ok] 40ms');
  });
});
