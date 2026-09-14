// Two-level section nav for /digital-twin (#3795). Nineteen sections in one
// flat strip gave the user 19 labels to scan with no inferable ordering, so
// they render as five groups (SECTION_GROUPS) over the sections themselves.
//
// The active section is the `:tab` route param — the caller passes it down and
// `onChange` navigates. The active GROUP is derived from it, never stored, so
// every existing deep link keeps resolving and there is no second source of
// truth for "what is open".
//
// The grouping is also what makes this fit a phone: `mobileCompact` collapses
// each row to icons below `sm`, and because only the active group's sections
// render, that is five group icons over at most six section icons — never the
// 19-wide scroll the groups were introduced to kill.
import TabPills from '../ui/TabPills';
import { SECTION_GROUPS, groupSections, sectionGroupId } from './constants';

export default function SectionNav({ activeSection, onChange }) {
  const activeGroupId = sectionGroupId(activeSection);
  const activeGroup = SECTION_GROUPS.find((g) => g.id === activeGroupId);
  const sections = groupSections(activeGroup);

  // Switching group lands on its first section — the group row is navigation,
  // not a mode toggle, so it must always resolve to a real URL.
  const handleGroupChange = (groupId) => {
    const group = SECTION_GROUPS.find((g) => g.id === groupId);
    if (group && !group.sectionIds.includes(activeSection)) onChange(group.sectionIds[0]);
  };

  return (
    <div className="shrink-0">
      <TabPills
        tabs={SECTION_GROUPS}
        activeTab={activeGroupId}
        onChange={handleGroupChange}
        mobileCompact
        ariaLabel="Digital Twin groups"
      />
      <TabPills
        tabs={sections}
        activeTab={activeSection}
        onChange={onChange}
        variant="pills"
        size="sm"
        mobileCompact
        ariaLabel={`${activeGroup.label} sections`}
        className="m-2"
      />
    </div>
  );
}
