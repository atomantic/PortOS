import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { plateRequirementBasis } from '../../../../server/lib/musicVideoPlateEvidence.js';
import PlateComparison from './PlateComparison.jsx';

it('compares the exact selected and candidate plates and reveals missing subjects', () => {
  const scene = { sceneId: 'shot-a', referenceImageId: 'one-person.png', direction: { actionContract: { version: 1, purpose: 'Two people greet' } }, takes: [] };
  const basis = plateRequirementBasis(scene);
  scene.takes = [
    { kind: 'image', assetId: 'one-person.png', plateEvidence: { assetId: 'one-person.png', basis, verdict: 'fail', checks: [{ id: 'person-b', status: 'fail', requirement: 'Second subject visible', note: 'Only one person is visible' }] } },
    { kind: 'image', assetId: 'two-people.png', plateEvidence: { assetId: 'two-people.png', basis, verdict: 'pass', checks: [] } },
  ];
  const { rerender } = render(<PlateComparison scene={scene} />);
  expect(screen.getByText('Selected · Requirements unmet')).toBeInTheDocument();
  expect(screen.getByText('Candidate · Ready')).toBeInTheDocument();
  expect(screen.getByText(/Only one person is visible/)).toBeInTheDocument();
  rerender(<PlateComparison scene={{ ...scene, referenceImageId: 'two-people.png', direction: { actionContract: { version: 1, purpose: 'Three people greet' } } }} />);
  expect(screen.getByText('Selected · Unverified')).toBeInTheDocument();
  expect(screen.queryByText('Candidate · Ready')).not.toBeInTheDocument();
});
