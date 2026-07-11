import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompositeSheetsEditor from './CompositeSheetsEditor.jsx';

const sheet = (over = {}) => ({ kind: 'reference_sheet', label: 'Costume sheet', prompt: 'A clean sheet.', locked: true, ...over });

describe('CompositeSheetsEditor', () => {
  it('shows the empty state and count', () => {
    render(<CompositeSheetsEditor sheets={[]} onChange={() => {}} />);
    expect(screen.getByText('No composite boards yet.')).toBeInTheDocument();
  });

  it('renders a board with its kind label', () => {
    render(<CompositeSheetsEditor sheets={[sheet({ kind: 'world_pitch_poster', label: 'Pitch' })]} onChange={() => {}} />);
    expect(screen.getByText('Pitch')).toBeInTheDocument();
    expect(screen.getByText('World pitch poster')).toBeInTheDocument();
  });

  it('removing a board calls onChange without it', async () => {
    const onChange = vi.fn();
    render(<CompositeSheetsEditor sheets={[sheet({ label: 'A' }), sheet({ label: 'B' })]} onChange={onChange} />);
    await userEvent.click(screen.getAllByTitle('Remove')[0]);
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ label: 'B' })]);
  });

  it('toggling a board lock flips its locked flag', async () => {
    const onChange = vi.fn();
    render(<CompositeSheetsEditor sheets={[sheet({ locked: true })]} onChange={onChange} />);
    await userEvent.click(screen.getByTitle('Locked — AI expand will preserve this board'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ locked: false })]);
  });

  it('render button only appears when onRender is provided and gates on canRender', async () => {
    const onRender = vi.fn();
    const s = sheet();
    render(<CompositeSheetsEditor sheets={[s]} onChange={() => {}} onRender={onRender} canRender />);
    await userEvent.click(screen.getByTitle('Render this board'));
    expect(onRender).toHaveBeenCalledWith(s);
  });
});
