import { describe, expect, it } from 'vitest';
import { PORTOS_APP_ID as serverAppId } from './appIdentity.js';
import { PORTOS_APP_ID as clientAppId } from '../../client/src/lib/appIdentity.js';

describe('appIdentity — server/client mirror parity', () => {
  it('keeps the baseline app id identical', () => {
    expect(clientAppId).toBe(serverAppId);
  });
});
