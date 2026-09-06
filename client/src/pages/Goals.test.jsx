import { describe, it, expect } from 'vitest';
import { TABS } from './Goals';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';

// Goals derives its tab bar from the nav manifest's `tabGroup: 'goals'` (#6365)
// — this pins that TABS stays in sync (id, label, declaration order) and that
// every manifest tab has a presentation entry (icon) in Goals.jsx, which would
// otherwise only surface as a thrown import-time error. The page-local
// "List"/"Tree" labels differ from the manifest's "Goals"/"Goals Tree" via
// the manifest's `tabLabel`.
describe('Goals TABS ↔ nav manifest', () => {
  it('derives every tab, in order, from the "goals" tabGroup with a presentation entry', () => {
    const manifestTabs = getPageNavTabs('goals');
    expect(TABS.map((t) => t.id)).toEqual(manifestTabs.map((t) => t.id));
    expect(TABS.map((t) => t.label)).toEqual(['List', 'Tree']);
    expect(TABS.every((t) => typeof t.icon === 'function' || typeof t.icon === 'object')).toBe(true);
  });
});
