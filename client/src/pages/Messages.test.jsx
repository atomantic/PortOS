import { describe, it } from 'vitest';
import { TABS } from './Messages';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

// Messages derives its tab bar from the nav manifest's `tabGroup: 'messages'`
// (#6365) — this pins that TABS stays in sync (id, label, declaration order)
// and that every manifest tab has a presentation entry (icon, plus the
// `fullBleed`/`needsAccounts` flags) in Messages.jsx, which would otherwise
// only surface as a thrown import-time error.
describe('Messages TABS ↔ nav manifest', () => {
  it('renders the messages tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'inbox:Inbox', 'drafts:Drafts', 'imessage:iMessage', 'signal:Signal', 'contacts:Contacts', 'sync:Sync', 'config:Config',
    ]);
  });
});
