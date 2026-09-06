import { describe, it } from 'vitest';
import { TABS } from './Goals';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

// Goals derives its tab bar from the nav manifest's `tabGroup: 'goals'` (#6365)
// — this pins that TABS stays in sync (id, label, declaration order) and that
// every manifest tab has a presentation entry (icon) in Goals.jsx, which would
// otherwise only surface as a thrown import-time error. The page-local
// "List"/"Tree" labels differ from the manifest's "Goals"/"Goals Tree" via
// the manifest's `tabLabel`.
describe('Goals TABS ↔ nav manifest', () => {
  it('renders the goals tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'list:List', 'tree:Tree',
    ]);
  });
});
