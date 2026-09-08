import { describe, it } from 'vitest';
import { TABS } from './constants';
import { expectPageNavTabs } from '../../test/pageNavTabAssertions.js';

// MeatSpace derives its tab bar from the nav manifest's `tabGroup: 'meatspace'`
// (#6383) — this pins the id/label/order the page means to render, and that
// every manifest tab has a presentation entry (icon) in constants.js, which
// would otherwise only surface as a thrown import-time error. The short "Health"
// label comes from the manifest's `tabLabel`; ⌘K and voice still show
// "Body Health" so it doesn't collide with CoS Health.
describe('MeatSpace TABS ↔ nav manifest', () => {
  it('renders the meatspace tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'overview:Overview', 'age:Age', 'alcohol:Alcohol', 'blood:Blood', 'body:Body',
      'export:Export', 'genome:Genome', 'health:Health', 'settings:Settings',
      'lifestyle:Lifestyle', 'nicotine:Nicotine',
    ]);
  });
});
