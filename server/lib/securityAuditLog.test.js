import { afterEach, describe, expect, it, vi } from 'vitest';
import { logSecurityEvent } from './securityAuditLog.js';

afterEach(() => vi.restoreAllMocks());

describe('logSecurityEvent', () => {
  it('routes refusals to warn and everything else to log, omitting empty fields', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(logSecurityEvent('login.ok', { ip: '192.0.2.1', session: null, note: '' })).toBe('🔐 Security [login.ok] ip=192.0.2.1');
    expect(log).toHaveBeenCalledTimes(1);
    logSecurityEvent('login.failed', { refused: true, ip: '192.0.2.1' });
    expect(warn).toHaveBeenCalledWith('⛔ Security [login.failed] ip=192.0.2.1');
  });

  it('cannot be used to forge a second log line from a caller-controlled value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = logSecurityEvent('request.refused', {
      refused: true,
      path: `/x\n🔐 Security [login.ok] ip=1.2.3.4${'a'.repeat(300)}`,
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('path="/x 🔐 Security [login.ok] ip=1.2.3.4');
    expect(line.length).toBeLessThan(200);
  });
});
