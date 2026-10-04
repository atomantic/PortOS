import { describe, expect, it } from 'vitest';
import { accountTypeCanSend, pickEmailSenderAccount, sendViaForAccountType } from './messageTransport.js';

describe('message account transports', () => {
  it('declares one transport per implemented account type and none for anything else', () => {
    expect(['gmail', 'outlook', 'teams'].map(sendViaForAccountType)).toEqual(['api', 'playwright', 'playwright']);
    expect(['gmail', 'outlook', 'teams'].every(accountTypeCanSend)).toBe(true);
    expect([sendViaForAccountType('signal'), accountTypeCanSend('signal'), accountTypeCanSend(undefined)]).toEqual([null, false, false]);
  });

  describe('pickEmailSenderAccount', () => {
    const account = (type, extra = {}) => ({ id: type, type, canSend: true, enabled: true, ...extra });

    it('prefers an API transport, never chooses a Teams chat, and honors the derived gate', () => {
      expect(pickEmailSenderAccount([account('outlook'), account('gmail')]).type).toBe('gmail');
      expect(pickEmailSenderAccount([account('teams'), account('outlook')]).type).toBe('outlook');
      expect(pickEmailSenderAccount([account('teams')])).toBeNull();
      expect(pickEmailSenderAccount([account('gmail', { canSend: false }), account('outlook', { enabled: false })])).toBeNull();
      expect(pickEmailSenderAccount([account('outlook', { canSend: undefined })])).toBeNull();
      expect(pickEmailSenderAccount()).toBeNull();
    });
  });
});
