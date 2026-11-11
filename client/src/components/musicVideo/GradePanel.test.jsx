// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GradePanel from './GradePanel.jsx';

describe('composition grade controls', () => {
  it('persists explicit presets and section overrides, then resets every section without changing other composition settings', () => {
    const onSave = vi.fn();
    const initial = { id: 'mv-example', scenes: [{ sceneId: 'verse', label: 'Verse' }], composition: { mode: 'document', posterSec: 3 } };
    function Editor() {
      const [project, setProject] = useState(initial);
      return <GradePanel project={project} onSave={(patch) => { onSave(patch); setProject((current) => ({ ...current, ...patch })); }} />;
    }
    render(<Editor />);
    expect(screen.getByLabelText('Default section look').value).toBe('neutral');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'teal-night' } });
    fireEvent.change(screen.getByLabelText('Verse'), { target: { value: 'golden-hour' } });
    expect(onSave).toHaveBeenLastCalledWith({ composition: expect.objectContaining({ mode: 'document', posterSec: 3,
      grade: { preset: 'teal-night', grain: 0.012, sections: [{ sceneId: 'verse', preset: 'golden-hour' }] },
    }) });
    fireEvent.click(screen.getByRole('button', { name: 'Reset grades to neutral' }));
    expect(screen.getByLabelText('Verse').value).toBe('');
    expect(onSave).toHaveBeenLastCalledWith({ composition: expect.objectContaining({ grade: { preset: 'neutral', grain: 0.012, sections: [] } }) });
  });

  it('saves and resets Blender film grades while preserving the Blender mode', () => {
    cleanup();
    const onSave = vi.fn();
    const initial = { id: 'mv-blender', scenes: [{ sceneId: 'shot-1', label: 'Shot 1' }], composition: {
      mode: 'blender', posterSec: 4, grade: { preset: 'teal-night', grain: 0.03, sections: [{ sceneId: 'shot-1', preset: 'golden-hour' }] },
    } };
    function Editor() {
      const [project, setProject] = useState(initial);
      return <GradePanel project={project} onSave={(patch) => { onSave(patch); setProject((current) => ({ ...current, ...patch })); }} />;
    }
    render(<Editor />);
    expect(screen.getAllByRole('region', { name: 'Render grade' })).toHaveLength(1);
    expect(screen.getByLabelText('Default section look').value).toBe('teal-night');
    expect(screen.getByLabelText('Shot 1').value).toBe('golden-hour');
    fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'monochrome' } });
    expect(onSave).toHaveBeenLastCalledWith({ composition: expect.objectContaining({ mode: 'blender', posterSec: 4,
      grade: expect.objectContaining({ preset: 'monochrome' }),
    }) });
    fireEvent.click(screen.getByRole('button', { name: 'Reset grades to neutral' }));
    expect(screen.getByLabelText('Default section look').value).toBe('neutral');
    expect(screen.getByLabelText('Shot 1').value).toBe('');
    expect(onSave).toHaveBeenLastCalledWith({ composition: expect.objectContaining({ mode: 'blender', posterSec: 4,
      grade: { preset: 'neutral', grain: 0.03, sections: [] },
    }) });
  });
});
