// Two-level section nav for /digital-twin (#3795). Nineteen sections in one
// flat strip gave the user 19 labels to scan with no inferable ordering, so
// they render as five groups (SECTION_GROUPS) over the sections themselves.
//
// The active section is the `:tab` route param — the caller passes it down and
// `onChange` navigates. The active GROUP is derived from it, never stored, so
// every existing deep link keeps resolving and there is no second source of
// truth for "what is open".
//
// Mobile is the case the issue measured: below `sm` the whole thing collapses
// to ONE grouped `<select>` (~40px, no horizontal scanning) instead of a
// 19-wide scrolling strip, which is what buys the fold back. TabPills'
// `mobileDropdown` can't serve this — it renders a flat option list, and the
// grouping is the entire point — so the select is spelled out here with
// `<optgroup>` headers.
import TabPills from '../ui/TabPills';
import { SECTION_GROUPS, groupSections, sectionGroupId } from './constants';

const SELECT_ID = 'digital-twin-section-select';

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
    <>
      <div className="sm:hidden shrink-0 border-b border-port-border p-2">
        <label htmlFor={SELECT_ID} className="sr-only">Digital Twin section</label>
        <select
          id={SELECT_ID}
          value={activeSection}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent min-h-[40px]"
        >
          {SECTION_GROUPS.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {groupSections(group).map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="hidden sm:block shrink-0">
        <TabPills
          tabs={SECTION_GROUPS}
          activeTab={activeGroupId}
          onChange={handleGroupChange}
          ariaLabel="Digital Twin groups"
        />
        <TabPills
          tabs={sections}
          activeTab={activeSection}
          onChange={onChange}
          variant="pills"
          size="sm"
          ariaLabel={`${activeGroup.label} sections`}
          className="m-2"
        />
      </div>
    </>
  );
}
