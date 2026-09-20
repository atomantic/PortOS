import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
vi.mock('./JevPanel', () => ({ default: () => <div>Jev controls</div> }));
vi.mock('./LayaMlxPanel', () => ({ default: () => <div>Laya controls</div> }));
import DecisionClassifiers from './DecisionClassifiers';
const Page = () => <DecisionClassifiers view={useParams().view} />;
it('keeps classifier selection in the URL and mounts only the selected adapter', async () => {
  render(<MemoryRouter initialEntries={['/models/decision-classifiers']}><Routes>
    <Route path="/models/decision-classifiers/:view?" element={<Page />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText('Jev controls')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Laya-MLX' }));
  expect(await screen.findByText('Laya controls')).toBeInTheDocument();
  expect(screen.queryByText('Jev controls')).not.toBeInTheDocument();
  const tab = screen.getByRole('tab', { name: 'Laya-MLX' });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveAttribute('id', tab.getAttribute('aria-controls'));
});
