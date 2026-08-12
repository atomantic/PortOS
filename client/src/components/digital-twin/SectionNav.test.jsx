import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import SectionNav from './SectionNav';
import { TABS, SECTION_GROUPS, groupSections, sectionGroupId } from './constants';

describe('digital-twin section taxonomy', () => {
  it('assigns every section to exactly one group', () => {
    const grouped = SECTION_GROUPS.flatMap((g) => g.sectionIds);
    expect([...grouped].sort()).toEqual(TABS.map((t) => t.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('names no section id that has no tab behind it', () => {
    const ids = new Set(TABS.map((t) => t.id));
    const orphans = SECTION_GROUPS.flatMap((g) => g.sectionIds).filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  it('keeps every group materially shorter than the old flat strip', () => {
    // The point of the grouping: no single row asks the user to scan 19 labels.
    for (const g of SECTION_GROUPS) expect(g.sectionIds.length).toBeLessThanOrEqual(6);
    expect(SECTION_GROUPS.length).toBeLessThanOrEqual(6);
  });

  it('resolves a section to its owning group', () => {
    expect(sectionGroupId('documents')).toBe('sources');
    expect(sectionGroupId('time-capsule')).toBe('legacy');
    expect(sectionGroupId('personality')).toBe('assessment');
  });

  it('falls back to the first group for an unknown section', () => {
    expect(sectionGroupId('not-a-section')).toBe(SECTION_GROUPS[0].id);
  });

  it('expands a group to its tab objects in declared order', () => {
    const sources = groupSections(SECTION_GROUPS.find((g) => g.id === 'sources'));
    expect(sources.map((t) => t.id)).toEqual(['documents', 'import', 'accounts', 'interview', 'autobiography', 'enrich']);
    expect(sources.every((t) => t.label && t.icon)).toBe(true);
  });
});

// "Legacy" names both a group and a section inside it, so every tab lookup is
// scoped to its own row rather than searched across the whole nav.
const groupTab = (name) => within(screen.getByRole('tablist', { name: 'Digital Twin groups' })).getByRole('tab', { name });

describe('SectionNav', () => {
  it('derives the active group from the section in the URL, with no local state', () => {
    const { rerender } = render(<SectionNav activeSection="documents" onChange={() => {}} />);
    expect(groupTab('Sources').getAttribute('aria-selected')).toBe('true');
    const sourcesRow = screen.getByRole('tablist', { name: 'Sources sections' });
    expect(within(sourcesRow).getByRole('tab', { name: /^Documents/ }).getAttribute('aria-selected')).toBe('true');

    // Changing only the prop (i.e. the route param) moves the group with it.
    rerender(<SectionNav activeSection="time-capsule" onChange={() => {}} />);
    expect(groupTab('Legacy').getAttribute('aria-selected')).toBe('true');
    expect(groupTab('Sources').getAttribute('aria-selected')).toBe('false');
  });

  it('shows only the active group’s sections, not all 19', () => {
    render(<SectionNav activeSection="voice" onChange={() => {}} />);
    const sectionRow = screen.getByRole('tablist', { name: 'Presence sections' });
    expect(within(sectionRow).getAllByRole('tab').map((b) => b.textContent)).toEqual(['Voice', 'Appearance', 'Avatar Bio']);
    expect(within(sectionRow).queryByRole('tab', { name: 'Documents' })).toBeNull();
  });

  it('navigates to a group’s first section when the group changes', () => {
    const onChange = vi.fn();
    render(<SectionNav activeSection="overview" onChange={onChange} />);
    fireEvent.click(groupTab('Assessment'));
    expect(onChange).toHaveBeenCalledWith('test');
  });

  it('does not re-navigate when the active section already lives in the clicked group', () => {
    const onChange = vi.fn();
    render(<SectionNav activeSection="taste" onChange={onChange} />);
    fireEvent.click(groupTab('Profile'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the picked section id when a section is clicked', () => {
    const onChange = vi.fn();
    render(<SectionNav activeSection="documents" onChange={onChange} />);
    const sourcesRow = screen.getByRole('tablist', { name: 'Sources sections' });
    fireEvent.click(within(sourcesRow).getByRole('tab', { name: /^Interview/ }));
    expect(onChange).toHaveBeenCalledWith('interview');
  });

  it('collapses to one labelled, grouped select on mobile that reaches every section', () => {
    const onChange = vi.fn();
    render(<SectionNav activeSection="overview" onChange={onChange} />);
    const select = screen.getByLabelText('Digital Twin section');
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('overview');

    const optgroups = [...select.querySelectorAll('optgroup')];
    expect(optgroups.map((g) => g.label)).toEqual(SECTION_GROUPS.map((g) => g.label));
    expect([...select.querySelectorAll('option')].map((o) => o.value).sort())
      .toEqual(TABS.map((t) => t.id).sort());

    fireEvent.change(select, { target: { value: 'legacy' } });
    expect(onChange).toHaveBeenCalledWith('legacy');
  });
});
