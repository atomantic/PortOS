import { describe, expect, it } from 'vitest';
import { SECTION_GROUPS, TABS } from './constants';
import { expectPageNavTabs } from '../../test/pageNavTabAssertions.js';

// Digital Twin derives its section strip from the nav manifest's
// `tabGroup: 'digital-twin'` (#6383) — this pins the id/label/order the page
// means to render, and that every manifest section has a presentation entry
// (icon) in constants.js, which would otherwise only surface as a thrown
// import-time error. The short "Goals"/"Legacy" labels come from the manifest's
// `tabLabel`; ⌘K and voice still show the qualified "Twin Goals"/"Legacy Bundle".
describe('Digital Twin TABS ↔ nav manifest', () => {
  it('renders the digital-twin tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'overview:Overview', 'identity:Identity', 'personas:Personas', 'goals:Goals',
      'taste:Taste', 'documents:Documents', 'import:Import', 'accounts:Accounts',
      'interview:Interview', 'autobiography:Autobiography', 'enrich:Enrich',
      'test:Test', 'personality:Personality', 'voice:Voice', 'appearance:Appearance',
      'avatar-bio:Avatar Bio', 'export:Export', 'legacy:Legacy', 'time-capsule:Time Capsule',
    ]);
  });

  // The two-level nav (#3795) slices the SAME ids back out of the manifest
  // order, so a section added to the tabGroup without a group lands nowhere.
  it('assigns every section to exactly one SECTION_GROUPS group', () => {
    const grouped = SECTION_GROUPS.flatMap((group) => group.sectionIds);
    expect([...grouped].sort()).toEqual(TABS.map((tab) => tab.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
