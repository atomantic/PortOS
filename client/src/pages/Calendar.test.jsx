import { describe, it } from 'vitest';
import { TABS } from './Calendar';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

// Calendar derives its tab bar from the nav manifest's `tabGroup: 'calendar'`
// (#6365) — this pins that TABS stays in sync (id, label, declaration order)
// and that every manifest tab has a presentation entry (icon) in Calendar.jsx,
// which would otherwise only surface as a thrown import-time error.
describe('Calendar TABS ↔ nav manifest', () => {
  it('renders the calendar tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'agenda:Agenda', 'day:Day', 'week:Week', 'month:Month', 'lifetime:Lifetime', 'review:Review', 'sync:Sync', 'config:Config',
    ]);
  });
});
