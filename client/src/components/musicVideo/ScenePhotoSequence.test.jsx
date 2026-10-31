import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ScenePhotoSequence from './ScenePhotoSequence.jsx';
import ImageEffectStill from './ImageEffectStill.jsx';
import { photoStackLayouts, scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';

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

  // #14277: catches a layout left on the wrong photo after reordering/removal,
  // the stack preset not keeping prior photos, and edits saved outside range.
  it('applies the photo stack, keeps layouts with their photos and edits one layout', () => {
    const save = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ visualLayer: 'still', photoSequence: { enabled: true, imageIds: ['a.png', 'b.png', 'c.png'], intervalFrames: 6 } });
      return <ScenePhotoSequence scene={scene} fieldId={name => name} onChange={patch => { save(patch); setScene(prev => ({ ...prev, ...patch })); }} />;
    }
    render(<Harness />);
    const last = () => save.mock.lastCall[0].photoSequence;
    fireEvent.click(screen.getByRole('button', { name: 'Photo stack layout' }));
    expect(last().layouts).toEqual(photoStackLayouts(3));
    expect(last().overlapFrames).toBe(12);
    const [first, second] = last().layouts;
    fireEvent.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(last().imageIds).toEqual(['b.png', 'a.png', 'c.png']);
    expect(last().layouts.slice(0, 2)).toEqual([second, first]);
    fireEvent.click(screen.getByRole('button', { name: 'Add existing photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose synthetic photo' }));
    expect(last().layouts).toHaveLength(4);
    expect(last().layouts[3]).toEqual(photoStackLayouts(4)[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout of photo 1' }));
    fireEvent.change(screen.getByLabelText('Opacity'), { target: { value: '50' } });
    expect(last().layouts[0]).toEqual({ ...second, opacity: 0.5 });
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '400' } });
    expect(last().layouts[0].scale).toBe(second.scale);
    // The open editor follows its photo when a neighbour moves past it.
    fireEvent.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(screen.getByText('Photo 2 layout')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Turn'), { target: { value: '7' } });
    expect(last().layouts[1]).toEqual({ ...second, opacity: 0.5, rotation: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Move photo 1 later' }));
    expect(screen.getByText('Photo 1 layout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Full frame' }));
    expect(last().layouts[0]).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(last().imageIds).toEqual(['a.png', 'c.png', 'picked.png']);
    expect(last().layouts).toEqual([first, photoStackLayouts(3)[2], photoStackLayouts(4)[3]]);
    fireEvent.change(screen.getByLabelText('Overlap'), { target: { value: '0' } });
    expect(last().overlapFrames).toBe(0);
  });

  // #14277: catches a preview that drops the outgoing photo during the overlap,
  // stacks it over the newer photo, or ignores its layout, against the render's layer list.
  it('paints earlier photos beneath the newer one for the overlap, in their layouts', () => {
    const layouts = photoStackLayouts(5).map((layout, i) => i === 1 ? { ...layout, opacity: 0.5 } : layout);
    const scene = { visualLayer: 'still', startSec: 0, endSec: 4,
      photoSequence: { imageIds: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'], intervalFrames: 6, overlapFrames: 12, layouts } };
    const sequence = scenePhotoSequence(scene);
    const { container, rerender } = render(<ImageEffectStill src="/unused.png" sequence={sequence} effect={null} startSec={0} time={0} />);
    const visible = () => [...container.querySelectorAll('img')].filter(img => img.style.display !== 'none');
    expect(visible().map(img => img.getAttribute('src'))).toEqual(['/data/images/a.png']);
    // Frame 13: photos a (until frame 18), b (until 24) and c, oldest first.
    rerender(<ImageEffectStill src="/unused.png" sequence={sequence} effect={null} startSec={0} time={13 / 24} />);
    expect(visible().map(img => img.getAttribute('src'))).toEqual(['/data/images/a.png', '/data/images/b.png', '/data/images/c.png']);
    expect(container.querySelector('img[data-shown="true"]').getAttribute('src')).toBe('/data/images/c.png');
    expect(visible()[1].style.opacity).toBe('0.5');
    expect(visible()[1].style.transform).toBe(`rotate(${layouts[1].rotation}deg)`);
    expect(visible()[0].style.width).toBe(`${layouts[0].scale * 100}%`);
    expect(visible()[0].style.maxWidth).toBe('none');
    // A develop effect filters the composed stack (black ground included), as the renders do.
    rerender(<ImageEffectStill src="/unused.png" sequence={sequence} effect={{ effect: 'flash-develop', developSec: 1 }} startSec={0} time={13 / 24} />);
    expect(container.querySelector('[data-photo-stack]').style.filter).toMatch(/^contrast\(/);
    expect(visible().every(img => !img.style.filter)).toBe(true);
    expect(visible()[1].dataset.layout).toBe([layouts[1].x, layouts[1].y, layouts[1].scale, layouts[1].rotation, 0.5].join(','));
    // Frame 18: photo a has left; b stays beneath c.
    rerender(<ImageEffectStill src="/unused.png" sequence={sequence} effect={null} startSec={0} time={18 / 24} />);
    expect(visible().map(img => img.getAttribute('src'))).toEqual(['/data/images/b.png', '/data/images/c.png', '/data/images/d.png']);
    rerender(<ImageEffectStill src="/unused.png" sequence={sequence} effect={null} startSec={0} time={0} />);
    expect(visible().map(img => img.getAttribute('src'))).toEqual(['/data/images/a.png']);
  });
});
