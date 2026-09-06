import { describe, it, expect } from 'vitest';
import { TABS } from './Calendar';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';

// Calendar derives its tab bar from the nav manifest's `tabGroup: 'calendar'`
// (#6365) — this pins that TABS stays in sync (id, label, declaration order)
// and that every manifest tab has a presentation entry (icon) in Calendar.jsx,
// which would otherwise only surface as a thrown import-time error.
describe('Calendar TABS ↔ nav manifest', () => {
  it('derives every tab, in order, from the "calendar" tabGroup with a presentation entry', () => {
    const manifestTabs = getPageNavTabs('calendar');
    expect(TABS.map((t) => t.id)).toEqual(manifestTabs.map((t) => t.id));
    expect(TABS.map((t) => t.label)).toEqual(manifestTabs.map((t) => t.label));
    expect(TABS.every((t) => typeof t.icon === 'function' || typeof t.icon === 'object')).toBe(true);
  });
});
