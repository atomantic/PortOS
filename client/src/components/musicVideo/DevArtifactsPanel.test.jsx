import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DevArtifactsPanel from './DevArtifactsPanel.jsx';

const sheet = { id: 'mvd-sheet', kind: 'cast-sets', title: 'Cast & Sets — Example', version: 3, status: 'pending', mimeType: 'text/html', updatedAt: '2026-01-01T00:00:00Z' };
const other = { id: 'mvd-other', kind: 'treatment', title: 'Treatment', version: 1, status: 'pending', mimeType: 'text/html', updatedAt: '2026-01-02T00:00:00Z' };

describe('DevArtifactsPanel review badge', () => {
  // A version saved after the stage approved it must not read as awaiting review.
  it('shows the approved Cast & Sets sheet as Approved even when its latest version is pending', () => {
    const project = { id: 'mv-example', devArtifacts: [sheet, other], castAndSets: { status: 'approved', artifactId: sheet.id } };
    render(<DevArtifactsPanel project={project} busy={false} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Open Cast & Sets/ }).textContent).toContain('Approved');
    expect(screen.getByRole('button', { name: /Open Treatment/ }).textContent).toContain('Pending review');
  });

  it('keeps the sheet pending while its check-in is still in review', () => {
    const project = { id: 'mv-example', devArtifacts: [sheet], castAndSets: { status: 'review', artifactId: sheet.id } };
    render(<DevArtifactsPanel project={project} busy={false} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Open Cast & Sets/ }).textContent).toContain('Pending review');
  });
});
