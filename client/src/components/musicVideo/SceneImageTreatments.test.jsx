import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { imageTreatmentDefaults } from '../../../../server/lib/musicVideo/musicVideoImageTreatments.js';
import SceneImageTreatments from './SceneImageTreatments.jsx';

it('previews and saves one photo treatment at a time, then restores the original with None', async () => {
  const save = vi.fn();
  function Fixture() {
    const [scene, setScene] = useState({
      sceneId: 'shot-2', referenceImageId: 'first.png', photoSequence: { imageIds: ['next.png'] },
      imageTreatments: [imageTreatmentDefaults('early', 'first.png')],
    });
    return <SceneImageTreatments project={{ id: 'video-1' }} scene={scene} onSave={async (id, patch) => {
      save(id, patch);
      setScene(current => ({ ...current, ...patch }));
      return true;
    }} />;
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: /Image Treatments/ }));
  fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'next.png' } });
  fireEvent.change(screen.getByLabelText('Treatment'), { target: { value: 'quartz' } });
  fireEvent.change(screen.getByLabelText('Exposure date'), { target: { value: '1985-11-23' } });
  fireEvent.click(screen.getByRole('button', { name: 'Red' }));
  const image = screen.getByRole('img', { name: 'Image treatment preview' });
  await waitFor(() => {
    const url = new URL(image.getAttribute('src'), 'https://example.invalid');
    expect(url.pathname).toBe('/api/music-video/video-1/scenes/shot-2/image-treatment');
    expect(JSON.parse(url.searchParams.get('treatment'))).toMatchObject({ imageId: 'next.png', type: 'quartz', date: '1985-11-23', color: '#ff4c34' });
  });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Compare original'));
  await waitFor(() => expect(image.getAttribute('src')).toBe('/data/images/next.png'));
  fireEvent.click(screen.getByRole('button', { name: 'Save treatment' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save treatment' })).toBeDisabled());
  expect(save.mock.lastCall[1].imageTreatments).toEqual([
    imageTreatmentDefaults('early', 'first.png'),
    { ...imageTreatmentDefaults('quartz', 'next.png'), date: '1985-11-23', color: '#ff4c34' },
  ]);
  fireEvent.change(screen.getByLabelText('Treatment'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save treatment' }));
  await waitFor(() => expect(save.mock.lastCall[1].imageTreatments).toEqual([imageTreatmentDefaults('early', 'first.png')]));
});
