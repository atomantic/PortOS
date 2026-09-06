import { describe, it, expect } from 'vitest';
import { TABS } from './Messages';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';

// Messages derives its tab bar from the nav manifest's `tabGroup: 'messages'`
// (#6365) — this pins that TABS stays in sync (id, label, declaration order)
// and that every manifest tab has a presentation entry (icon, plus the
// `fullBleed`/`needsAccounts` flags) in Messages.jsx, which would otherwise
// only surface as a thrown import-time error.
describe('Messages TABS ↔ nav manifest', () => {
  it('derives every tab, in order, from the "messages" tabGroup with a presentation entry', () => {
    const manifestTabs = getPageNavTabs('messages');
    expect(TABS.map((t) => t.id)).toEqual(manifestTabs.map((t) => t.id));
    expect(TABS.map((t) => t.label)).toEqual(manifestTabs.map((t) => t.label));
    expect(TABS.every((t) => typeof t.icon === 'function' || typeof t.icon === 'object')).toBe(true);
  });
});
