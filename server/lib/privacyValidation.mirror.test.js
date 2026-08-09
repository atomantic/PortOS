/**
 * Mirror parity: server/lib/privacyValidation.js ↔ client/src/components/privacy/constants.js
 *
 * The client's constants file opens by claiming it is "kept in sync with the
 * server Zod schemas — a mismatch would let the UI offer a value the API
 * rejects." Until now nothing enforced that claim, so the sync was a comment.
 *
 * Household subjects (#3658) made the drift expensive rather than cosmetic: the
 * consent-method list is what a user picks when adding a person, and a method
 * the server enum doesn't carry means the add fails at the last click — after
 * they've typed a name and chosen how consent was captured.
 *
 * The two sides intentionally differ in SHAPE: the server holds bare id arrays
 * for `z.enum()`, the client holds `[{ id, label }]` so the UI has display text.
 * Only the id sets are compared, so adding or rewording a label is free.
 *
 * Safe to import the client module from a server suite: constants.js has zero
 * imports (a dep-free leaf), so this does not drag client-only packages into
 * the server job's dependency set.
 */

import { describe, it, expect } from 'vitest';
import * as server from './privacyValidation.js';
import * as client from '../../client/src/components/privacy/constants.js';

// [client export, server export] — every enum the UI offers as a choice.
const MIRRORED_ENUMS = [
  ['SUBJECT_RELATIONSHIPS', 'PRIVACY_SUBJECT_RELATIONSHIPS'],
  ['CONSENT_METHODS', 'PRIVACY_CONSENT_METHODS'],
  ['CONSENT_SCOPES', 'PRIVACY_CONSENT_SCOPES'],
  ['VAULT_TYPES', 'PRIVACY_VAULT_TYPES'],
  ['VAULT_STATUSES', 'PRIVACY_VAULT_STATUSES'],
  ['ORG_CATEGORIES', 'PRIVACY_ORG_CATEGORIES'],
  ['ORG_TRUST_LEVELS', 'PRIVACY_ORG_TRUST_LEVELS'],
  ['ORG_STATUSES', 'PRIVACY_ORG_STATUSES'],
  ['ORG_HOLDING_STATUSES', 'PRIVACY_ORG_HOLDING_STATUSES'],
  ['CHANGE_KINDS', 'PRIVACY_CHANGE_KINDS'],
  ['CASE_STATES', 'PRIVACY_BROKER_CASE_STATES'],
];

describe('privacy enums server↔client mirror parity', () => {
  it.each(MIRRORED_ENUMS)('%s matches %s', (clientName, serverName) => {
    const clientList = client[clientName];
    const serverList = server[serverName];
    expect(Array.isArray(clientList), `client ${clientName} missing`).toBe(true);
    expect(Array.isArray(serverList), `server ${serverName} missing`).toBe(true);
    // Order is a UI concern (display order); membership is the contract.
    expect([...clientList.map((x) => x.id)].sort()).toEqual([...serverList].sort());
  });

  it.each(MIRRORED_ENUMS)('%s entries all carry a display label', (clientName) => {
    for (const entry of client[clientName]) {
      expect(typeof entry.label, `${clientName}.${entry.id} label`).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  // Flat id arrays on both sides — no { id, label } shape to unwrap.
  it('SENSITIVE_TYPES matches PRIVACY_SENSITIVE_TYPES', () => {
    expect([...client.SENSITIVE_TYPES].sort()).toEqual([...server.PRIVACY_SENSITIVE_TYPES].sort());
  });

  // Not an enum, but the same class of drift: the client defaults its subject
  // scope to this id, so a mismatch would scope the whole UI to a subject the
  // server has never heard of.
  it('SELF_SUBJECT_ID matches PRIVACY_SELF_SUBJECT_ID', () => {
    expect(client.SELF_SUBJECT_ID).toBe(server.PRIVACY_SELF_SUBJECT_ID);
  });

  it('every sensitive type is a real vault type', () => {
    const vaultIds = client.VAULT_TYPES.map((t) => t.id);
    for (const t of client.SENSITIVE_TYPES) expect(vaultIds).toContain(t);
  });

  // The tone tables are pre-composed Tailwind tokens keyed by enum id; a state
  // added to one side and not the other renders an unstyled badge.
  it('CASE_STATE_TONE covers every case state', () => {
    for (const s of client.CASE_STATES) expect(client.CASE_STATE_TONE).toHaveProperty(s.id);
  });

  it('TRUST_TONE covers every trust level', () => {
    for (const t of client.ORG_TRUST_LEVELS) expect(client.TRUST_TONE).toHaveProperty(t.id);
  });
});
