import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ScenePhotoSequence from './ScenePhotoSequence.jsx';
import ImageEffectStill from './ImageEffectStill.jsx';
import { scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';

vi.mock('../imageGen/GalleryImagePicker.jsx', () => ({ default: ({ onSelect, onClose }) => <button onClick={() => { onSelect({ filename: 'picked.png' }); onClose(); }}>Choose synthetic photo</button> }));

describe('still photo sequence authoring and scrubbing', () => {
  // Catches the user losing order/cadence when switching off, or photo selection
  // accidentally replacing the shot's ordinary reference still.
  it('picks, reorders, removes and changes cadence while preserving settings when disabled', () => {
    const save = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ visualLayer: 'still', referenceImageId: 'ordinary.png' });
      return <ScenePhotoSequence scene={scene} fieldId={name => name} beats={[0, 1, 2]} onChange={patch => {
        save(patch); setScene(prev => ({ ...prev, ...patch }));
      }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Photo sequence'));
    fireEvent.click(screen.getByRole('button', { name: 'Add existing photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose synthetic photo' }));
    expect(save.mock.lastCall[0].photoSequence.imageIds).toEqual(['ordinary.png', 'picked.png']);
    fireEvent.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(save.mock.lastCall[0].photoSequence.imageIds).toEqual(['picked.png', 'ordinary.png']);
    fireEvent.change(screen.getByLabelText('Photo interval unit'), { target: { value: 'seconds' } });
    fireEvent.change(screen.getByLabelText('Photo interval'), { target: { value: '0.5' } });
    expect(save.mock.lastCall[0].photoSequence.intervalFrames).toBe(12);
    fireEvent.change(screen.getByLabelText('Cadence'), { target: { value: 'half' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 2' }));
    fireEvent.click(screen.getByLabelText('Photo sequence'));
    expect(save.mock.lastCall[0].photoSequence).toEqual({ enabled: false, imageIds: ['picked.png'], intervalFrames: 12, rate: 'half' });
    expect(save.mock.calls.every(([patch]) => !('referenceImageId' in patch))).toBe(true);
  });

  // Catches scene-relative or playback-only selection: a backwards scrub and
  // the exact switching frame must show the same image as a rendered frame.
  it('selects the absolute song frame while scrubbing, beneath the existing still effect', () => {
    const scene = { visualLayer: 'still', startSec: 10.25, endSec: 14,
      photoSequence: { imageIds: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'], intervalFrames: 6 } };
    const sequence = scenePhotoSequence(scene);
    const props = { src: '/unused.png', sequence, effect: { effect: 'flash-develop', developSec: 1 }, startSec: scene.startSec };
    const { container, rerender } = render(<ImageEffectStill {...props} time={10.25} />);
    const shown = () => container.querySelector('img[data-shown="true"]').getAttribute('src');
    expect(shown()).toBe('/data/images/a.png');
    rerender(<ImageEffectStill {...props} time={10.5} />);
    expect(shown()).toBe('/data/images/b.png');
    rerender(<ImageEffectStill {...props} time={11.5} />);
    expect(shown()).toBe('/data/images/a.png');
    rerender(<ImageEffectStill {...props} time={10.49} />);
    expect(shown()).toBe('/data/images/a.png');
  });
});
