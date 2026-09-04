import { describe, it, expect } from 'vitest';
import { buildPersonMatchIndex } from '../lib/tribeMatch.js';
import { buildContactIndex, mergeContacts } from './contactsSync.js';
import {
  resolveHandle,
  displayLabel,
  enrichConversationRow,
  enrichActivityEvent,
  createHandleResolver,
} from './identityResolve.js';

describe('identityResolve', () => {
  const people = [
    { id: 'p1', name: 'Tribe Friend', phones: ['+15551234567'], emails: ['friend@example.com'] },
  ];
  const tribeIndex = {
    ...buildPersonMatchIndex(people),
    byId: new Map(people.map((p) => [p.id, p])),
  };
  const contacts = mergeContacts([[
    { uniqueId: 'c1', firstName: 'Contact', lastName: 'Only', phones: ['+15559876543'], emails: [] },
    { uniqueId: 'c2', firstName: 'Also', lastName: 'Friend', phones: ['+15551234567'], emails: [] },
  ]]);
  const contactIndex = buildContactIndex(contacts);
  const ctx = { tribeIndex, contactIndex };

  it('prefers Tribe over Contacts for the same phone', () => {
    const r = resolveHandle('+1 555 123 4567', ctx);
    expect(r.source).toBe('tribe');
    expect(r.personId).toBe('p1');
    expect(r.displayName).toBe('Tribe Friend');
  });

  it('falls back to Contacts when not in Tribe', () => {
    const r = resolveHandle('5559876543', ctx);
    expect(r.source).toBe('contacts');
    expect(r.displayName).toBe('Contact Only');
  });

  it('returns null source for unknown handles', () => {
    const r = resolveHandle('+19990001111', ctx);
    expect(r.source).toBeNull();
    expect(r.displayName).toBeNull();
    expect(displayLabel(r, '+19990001111')).toBe('+19990001111');
  });

  it('enriches conversation rows when title is a raw handle', () => {
    const row = enrichConversationRow({
      handle: '+15559876543',
      title: '+15559876543',
      lastSummary: 'hi',
    }, ctx);
    expect(row.displayName).toBe('Contact Only');
    expect(row.title).toBe('Contact Only');
    expect(row.identitySource).toBe('contacts');
  });

  it('keeps a custom chat title that is not the handle', () => {
    const row = enrichConversationRow({
      handle: '+15559876543',
      title: 'Family Group',
    }, ctx);
    expect(row.title).toBe('Family Group');
    expect(row.displayName).toBe('Contact Only');
  });

  it('enriches activity event participants', () => {
    const ev = enrichActivityEvent({
      title: '+15551234567',
      metadata: { handle: '+15551234567' },
      participants: [{ phone: '+15551234567' }],
    }, ctx);
    expect(ev.personId).toBe('p1');
    expect(ev.participants[0].name).toBe('Tribe Friend');
    expect(ev.participants[0].personId).toBe('p1');
  });

  // #6025: bulk callers (the outreach scan) hand enrichActivityEvent one memoizing
  // resolver so a repeated counterpart handle is matched once, not once per event.
  it('memoizes repeated handles and enriches identically through an injected resolver', () => {
    const resolver = createHandleResolver(ctx);
    expect(resolver('+15551234567')).toBe(resolver('+15551234567'));
    expect(resolver('+15559876543').displayName).toBe('Contact Only');

    let injectedCalls = 0;
    const counting = (h) => { injectedCalls += 1; return resolver(h); };
    const event = {
      title: '+15551234567',
      metadata: { handle: '+15551234567' },
      participants: [{ phone: '+15551234567' }],
    };
    // The injected resolver is used for every lookup, and the enrichment is
    // byte-identical to the uncached default path.
    expect(enrichActivityEvent(event, ctx, counting)).toEqual(enrichActivityEvent(event, ctx));
    expect(injectedCalls).toBeGreaterThan(0);
  });
});
