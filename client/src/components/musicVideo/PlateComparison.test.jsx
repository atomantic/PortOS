import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { plateRequirementBasis, plateRequirements } from '../../../../server/lib/musicVideoPlateEvidence.js';
import PlateComparison from './PlateComparison.jsx';

it('compares the exact selected and candidate plates and reveals missing subjects', () => {
  const scene = { sceneId: 'shot-a', referenceImageId: 'one-person.png', direction: { actionContract: { version: 1, purpose: 'Two people greet', activeSpeaker: 'Person B' } }, takes: [] };
  const basis = plateRequirementBasis(scene);
  scene.takes = [
    { kind: 'image', assetId: 'one-person.png', plateEvidence: { assetId: 'one-person.png', basis, verdict: 'fail', checks: plateRequirements(scene).map(({ id, requirement }) => ({ id, requirement, status: id === 'plate-1' ? 'fail' : 'pass', note: id === 'plate-1' ? 'Only one person is visible' : 'Visible' })) } },
    { kind: 'image', assetId: 'two-people.png', plateEvidence: { assetId: 'two-people.png', basis, verdict: 'pass', checks: plateRequirements(scene).map(({ id, requirement }) => ({ id, requirement, status: 'pass', note: 'Visible' })) } },
  ];
  const { rerender } = render(<PlateComparison scene={scene} />);
  expect(screen.getByText('Selected · Requirements unmet')).toBeInTheDocument();
  expect(screen.getByText('Candidate · Ready')).toBeInTheDocument();
  expect(screen.getByText(/Only one person is visible/)).toBeInTheDocument();
  rerender(<PlateComparison scene={{ ...scene, referenceImageId: 'two-people.png', direction: { actionContract: { version: 1, purpose: 'Three people greet' } } }} />);
  expect(screen.getByText('Selected · Unverified')).toBeInTheDocument();
  expect(screen.queryByText('Candidate · Ready')).not.toBeInTheDocument();
});

it('treats malformed persisted checks as unverified instead of crashing', () => {
  const scene = { sceneId: 'shot-a', referenceImageId: 'example.png', direction: { actionContract: { version: 1, purpose: 'A greeting' } }, takes: [] };
  scene.takes.push({ kind: 'image', assetId: 'example.png', plateEvidence: { assetId: 'example.png', basis: plateRequirementBasis(scene), verdict: 'pass', checks: [null] } });
  render(<PlateComparison scene={scene} />);
  expect(screen.getByText('Selected · Unverified')).toBeInTheDocument();
});
