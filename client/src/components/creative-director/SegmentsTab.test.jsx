import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import SegmentsTab from './SegmentsTab.jsx';
it('restores the selected shot from its URL without changing the project ID', () => {
  const project = { id: 'existing-project', treatment: { scenes: [{ sceneId: 'shot-a', order: 0, intent: 'Opening', status: 'pending' }, { sceneId: 'shot-b', order: 1, intent: 'Closing', status: 'pending' }] } };
  render(<MemoryRouter initialEntries={['/video/existing-project/segments/shot-b']}><Routes><Route path="/video/:id/:tab/:sceneId" element={<SegmentsTab project={project} basePath="/video" />} /></Routes></MemoryRouter>);
  expect(screen.getByText('Closing')).toBeTruthy();
  expect(screen.queryByText('Opening')).toBeNull();
  expect(screen.getByRole('link', { name: 'View all shots' })).toHaveAttribute('href', '/video/existing-project/segments');
  expect(screen.getByRole('link', { name: 'Scene 2' })).toHaveAttribute('href', '/video/existing-project/segments/shot-b');
});
