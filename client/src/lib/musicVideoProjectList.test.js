import { describe, it, expect } from 'vitest';
import { groupMusicVideoProjects, projectRunPill, compareMusicVideoProjectsRecentlyTouched } from './musicVideoProjectList.js';

describe('groupMusicVideoProjects', () => {
  const projects = [
    { id: 'a1', name: 'Alpha', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'a2', name: 'Alpha v2', version: 2, rootProjectId: 'a1', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
    { id: 'b1', name: 'Beta', version: 1, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
  ];

  it('collapses forks under their root, newest version first, and orders groups by last touch', () => {
    const groups = groupMusicVideoProjects(projects);
    expect(groups.map((g) => g.rootId)).toEqual(['b1', 'a1']);
    expect(groups[1].versions.map((v) => v.id)).toEqual(['a2', 'a1']);
  });

  it('filters by name, keeping only matching versions', () => {
    const groups = groupMusicVideoProjects(projects, ' v2 ');
    expect(groups).toHaveLength(1);
    expect(groups[0].versions.map((v) => v.id)).toEqual(['a2']);
  });

  it('sorts a background-updated project to the top', () => {
    const touched = projects.map((p) => (p.id === 'a1' ? { ...p, updatedAt: '2026-03-01T00:00:00Z' } : p));
    expect(groupMusicVideoProjects(touched)[0].rootId).toBe('a1');
    expect(compareMusicVideoProjectsRecentlyTouched(touched[0], touched[2])).toBeLessThan(0);
  });
});

describe('projectRunPill', () => {
  it('reports interrupted, needs-you and running autonomous runs', () => {
    expect(projectRunPill({ id: 'p', autonomousRun: { status: 'running', interrupted: true } }).id).toBe('interrupted');
    expect(projectRunPill({ id: 'p', autonomousRun: { status: 'awaiting-approval', awaiting: 'lyrics' } }).id).toBe('needs-you');
    expect(projectRunPill({ id: 'p', autonomousRun: { status: 'running', stage: 'lyrics' } }).id).toBe('running');
  });

  it('is null for an idle new project', () => {
    expect(projectRunPill({ id: 'p', status: 'draft' })).toBeNull();
  });
});
