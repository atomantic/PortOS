import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompositeSheetsEditor from './CompositeSheetsEditor.jsx';

// The row's thumbnail slot subscribes to its in-flight job through
// useMediaJobProgress (socket + fetch). Stub it so the rows render offline;
// `job` is mutable so a test can drive the completion / failure paths.
let job = { status: 'queued', filename: null, error: null };
vi.mock('../../hooks/useMediaJobProgress', () => ({
  default: () => ({ progress: 0, step: 0, totalSteps: 0, currentImage: null, ...job }),
}));

const sheet = (over = {}) => ({ kind: 'reference_sheet', label: 'Costume sheet', prompt: 'A clean sheet.', locked: true, ...over });

beforeEach(() => { job = { status: 'queued', filename: null, error: null }; });

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

  it('shows a thumbnail for a board that has rendered images', () => {
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ label: 'Pitch', imageRefs: ['old.png', 'newest.png'] })]}
        onChange={() => {}}
      />,
    );
    const img = screen.getByAltText('Pitch render');
    expect(img).toHaveAttribute('src', '/data/image-thumbnails/newest.webp');
  });

  it('clicking a rendered thumbnail opens the preview with the visible filename', async () => {
    const onPreview = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ label: 'Pitch', imageRefs: ['newest.png'] })]}
        onChange={() => {}}
        onPreview={onPreview}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /preview pitch render/i }));
    expect(onPreview).toHaveBeenCalledWith('newest.png');
  });

  it('a board with no renders offers the empty-state render affordance', async () => {
    const onRender = vi.fn();
    const s = sheet();
    render(<CompositeSheetsEditor sheets={[s]} onChange={() => {}} onRender={onRender} canRender />);
    await userEvent.click(screen.getByRole('button', { name: /render image for this item/i }));
    expect(onRender).toHaveBeenCalledWith(s);
  });

  it('settles with the rendered filename when the row\'s in-flight job completes', async () => {
    job = { status: 'completed', filename: 'fresh.png', error: null };
    const onJobSettled = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ id: 'sheet-1' })]}
        onChange={() => {}}
        pendingByEntryId={{ 'sheet-1': 'job-9' }}
        onJobSettled={onJobSettled}
      />,
    );
    await waitFor(() => expect(onJobSettled).toHaveBeenCalledWith('sheet-1', 'fresh.png', 'job-9'));
  });

  // MediaJobThumb fires its onFilename effect on [effectiveFilename, onFilename],
  // so an unstable callback identity would re-settle the same job on every parent
  // re-render — each one a full gallery refetch. Re-rendering with untouched props
  // must not produce a second settle.
  it('settles a completed job once, not once per parent re-render', async () => {
    job = { status: 'completed', filename: 'fresh.png', error: null };
    const onJobSettled = vi.fn();
    const props = {
      sheets: [sheet({ id: 'sheet-1' })],
      onChange: () => {},
      pendingByEntryId: { 'sheet-1': 'job-9' },
      onJobSettled,
    };
    const { rerender } = render(<CompositeSheetsEditor {...props} />);
    await waitFor(() => expect(onJobSettled).toHaveBeenCalled());
    rerender(<CompositeSheetsEditor {...props} />);
    rerender(<CompositeSheetsEditor {...props} />);
    expect(onJobSettled).toHaveBeenCalledTimes(1);
  });

  it('settles with a null filename on a terminal failure so the parent still clears the pending entry', async () => {
    job = { status: 'failed', filename: null, error: 'boom' };
    const onJobSettled = vi.fn();
    const onJobFailed = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ id: 'sheet-1' })]}
        onChange={() => {}}
        pendingByEntryId={{ 'sheet-1': 'job-9' }}
        onJobSettled={onJobSettled}
        onJobFailed={onJobFailed}
      />,
    );
    await waitFor(() => expect(onJobSettled).toHaveBeenCalledWith('sheet-1', null, 'job-9'));
    // Reported separately so the parent can toast a failure without having to
    // tell one apart from a user-initiated cancel.
    expect(onJobFailed).toHaveBeenCalledWith('sheet-1', 'failed');
  });

  it('does not report a failure when the job merely completes', async () => {
    job = { status: 'completed', filename: 'fresh.png', error: null };
    const onJobFailed = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ id: 'sheet-1' })]}
        onChange={() => {}}
        pendingByEntryId={{ 'sheet-1': 'job-9' }}
        onJobSettled={vi.fn()}
        onJobFailed={onJobFailed}
      />,
    );
    await waitFor(() => expect(screen.getByText('Costume sheet')).toBeInTheDocument());
    expect(onJobFailed).not.toHaveBeenCalled();
  });
});
