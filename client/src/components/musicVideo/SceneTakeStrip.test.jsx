import { plateReviewEvidence, plateRequirements } from '../../../../server/lib/musicVideo/musicVideoPlateEvidence.js';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneTakeStrip from './SceneTakeStrip.jsx';

const take = (takeId, assetId, extra = {}) => ({ takeId, kind: 'image', assetId, status: 'candidate', source: 'generated', ...extra });
const scene = { sceneId: 's1', order: 0, referenceImageId: 'a.png', takes: [take('t1', 'a.png'), take('t2', 'b.png', { status: 'rejected' })] };

it('flags a clip whose external cast guides cannot be tracked', () => {
  const clip = { takeId: 'v1', kind: 'video', assetId: 'clip', status: 'candidate',
    dependencies: { version: 1, references: [{ role: 'clipReferences', untrackedCastGuides: true }] } };
  render(<SceneTakeStrip scene={{ ...scene, takes: [clip] }} kind="video" />);
  expect(screen.getByText(/Cast guide changes are not tracked/)).toBeTruthy();
});

describe('rejecting a take versus marking it bad', () => {
  // Uniquely catches a take rejected from this shot reading as bad, or the Bad toggle not reaching the project-wide mark.
  it('offers Restore on a rejected take without a label, and marks or clears bad on its own', () => {
    const onMark = vi.fn();
    const { rerender } = render(<SceneTakeStrip scene={scene} kind="image" marks={{}} onMark={onMark} />);
    expect(screen.queryByText('Not for this shot')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByText(/generated/)).toBeNull();
    expect(screen.queryByText('Bad', { selector: 'span' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Bad' })[1]);
    expect(onMark).toHaveBeenCalledWith(scene.takes[1], 'bad');
    rerender(<SceneTakeStrip scene={scene} kind="image" marks={{ 'image:b.png': 'bad' }} onMark={onMark} />);
    // The pressed toggle carries the mark; the frame itself wears no Bad label.
    expect(screen.queryByText('Bad', { selector: 'span' })).toBeNull();
    const toggle = screen.getAllByRole('button', { name: 'Bad' })[1];
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(onMark).toHaveBeenLastCalledWith(scene.takes[1], null);
  });
});

// Uniquely pins the displayed defect and exact acknowledgement payload on the take the operator saw.
it('shows a rendering defect with an acknowledgement bound to that image and note', () => {
  const selected = { ...scene, framePrompt: 'A desk with a chair', takes: [take('t1', 'a.png')] };
  selected.takes[0].plateEvidence = plateReviewEvidence(selected, 'a.png', 'run-example', JSON.stringify({ checks: plateRequirements(selected).map(({ id }) => ({
    id, status: id === 'render-quality' ? 'fail' : 'pass', note: id === 'render-quality' ? 'The chair is fused into the desk.' : 'Matches',
  })) }));
  const onReview = vi.fn();
  render(<SceneTakeStrip scene={selected} kind="image" onReview={onReview} />);
  expect(screen.getByText('Rendering defect: The chair is fused into the desk.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge rendering defect' }));
  expect(onReview).toHaveBeenCalledWith(selected.takes[0], { acknowledgeRenderQuality: { basis: selected.takes[0].plateEvidence.basis, note: 'The chair is fused into the desk.' } });
});

// Uniquely catches an unchecked frame wearing a verdict badge, the Check action not reaching its handler,
// or a check's misses staying hidden behind the badge.
it('shows a verdict only after a check, opens it to the misses, and checks a frame in place', () => {
  const onCheck = vi.fn();
  const fresh = { ...scene, framePrompt: 'A desk with a chair', takes: [take('t1', 'a.png')] };
  const { rerender } = render(<SceneTakeStrip scene={fresh} kind="image" onCheck={onCheck} checking={new Set()} />);
  expect(screen.queryByText(/Unverified|Unclear|Issues|Checked/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  expect(onCheck).toHaveBeenCalledWith(fresh.takes[0]);

  rerender(<SceneTakeStrip scene={fresh} kind="image" onCheck={onCheck} checking={new Set(['t1'])} />);
  expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled();

  fresh.takes[0].plateEvidence = plateReviewEvidence(fresh, 'a.png', 'manual-example', JSON.stringify({ checks: plateRequirements(fresh).map(({ id }) => ({
    id, status: id === 'plate-prompt' ? 'fail' : 'pass', note: id === 'plate-prompt' ? 'There is no chair.' : 'Clean',
  })) }));
  rerender(<SceneTakeStrip scene={{ ...fresh }} kind="image" onCheck={onCheck} checking={new Set()} />);
  expect(screen.queryByText('There is no chair.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Issues (1)' }));
  expect(screen.getByText('There is no chair.')).toBeInTheDocument();
});

// Uniquely catches the take card's copy actions reverting to the full-width buttons.
it('shows compact copy chips on a take card', () => {
  render(<SceneTakeStrip scene={scene} kind="image" />);
  const copyId = screen.getAllByRole('button', { name: 'Copy ID' })[0];
  expect(copyId.textContent.trim()).toBe('ID');
});

// A camera-bound review must stay visible for its exact project camera and retire when its rule changes.
it('keeps camera-bound verdict badges current against the project camera rule', () => {
  const selected = { ...scene, shotSheet: { cameraId: 'camera' }, framePrompt: 'A view across the room', takes: [take('t1', 'a.png')] };
  const project = { cameras: [{ id: 'camera', name: 'Main', kind: 'observer', rule: 'Stay at the doorway' }] };
  selected.takes[0].plateEvidence = plateReviewEvidence(selected, 'a.png', 'camera-review', JSON.stringify({ checks: plateRequirements(selected, [], 'start', project).map(({ id }) => ({ id, status: 'pass', note: 'Matches the inspected frame' })) }), {}, [], 'start', project);
  const { rerender } = render(<SceneTakeStrip scene={selected} project={project} kind="image" />);
  expect(screen.getByText('Checked')).toBeInTheDocument();
  rerender(<SceneTakeStrip scene={selected} project={{ cameras: [{ ...project.cameras[0], rule: 'Stay behind the subject' }] }} kind="image" />);
  expect(screen.queryByText('Checked')).toBeNull();
});

// Uniquely catches a stale selected frame offering no way to keep it, the confirmation reaching the wrong take,
// or an unselected stale frame offering it.
it('offers Still matches on the selected frame made for an earlier version of the shot', () => {
  const stale = { status: 'stale', reasons: ['Frame prompt changed'] };
  const shot = { ...scene, takes: [take('t1', 'a.png', { dependencyState: stale }), take('t2', 'b.png', { dependencyState: stale })] };
  const onReview = vi.fn();
  render(<SceneTakeStrip scene={shot} kind="image" onReview={onReview} />);
  expect(screen.getByText('Made for an earlier version of this shot: Frame prompt changed')).toBeInTheDocument();
  const buttons = screen.getAllByRole('button', { name: 'Still matches' });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(onReview).toHaveBeenCalledWith(shot.takes[0], { confirmFrame: true });
});

// Uniquely catches the older-character-reference warning (#16473) not reaching the selected clip, its Still matches
// sending another revision than the warning showed, or an unselected take offering it.
it('offers Still matches on a selected clip rendered from an older character reference, bound to its revision', () => {
  const warning = { code: 'character-reference-changed', reasons: ['Started from a frame rendered with an older character reference: Ada'], characters: [{ subjectId: 'a', name: 'Ada' }], revision: 'rev-7', inherited: true };
  const clip = (takeId, assetId) => ({ takeId, kind: 'video', assetId, status: 'candidate', source: 'generated', characterReferenceState: warning });
  const shot = { ...scene, videoHistoryId: 'clip-1', takes: [clip('v1', 'clip-1'), clip('v2', 'clip-2')] };
  const onReview = vi.fn();
  render(<SceneTakeStrip scene={shot} kind="video" onReview={onReview} />);
  expect(screen.getByText('Started from a frame rendered with an older character reference: Ada')).toBeInTheDocument();
  const buttons = screen.getAllByRole('button', { name: 'Still matches' });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(onReview).toHaveBeenCalledWith(shot.takes[0], { acceptCharacterReferences: { revision: 'rev-7' } });
});

// #16128: a take shared by a run of shots says where this shot's window starts.
it('labels a sequence take with its place in the run and this shot\'s in-point', () => {
  const clip = { takeId: 'v1', kind: 'video', assetId: 'clip', status: 'candidate', source: 'generated',
    sequence: { sceneIds: ['s0', 's1', 's2'], index: 1, offsetFrames: 53, from: 'cut' } };
  const project = { scenes: [{ sceneId: 's0', label: 'Diner wide' }, { sceneId: 's1', label: 'Booth' }, { sceneId: 's2', label: 'Exit' }] };
  render(<SceneTakeStrip project={project} scene={{ sceneId: 's1', order: 1, takes: [clip] }} kind="video" />);
  const label = screen.getByTestId('sequence-take-label');
  expect(label.textContent).toBe('One take · 2/3 · in 2.21s');
  expect(label.getAttribute('title')).toBe('One take across Diner wide, Booth, Exit. This shot plays from 2.21s, at its detected cut; nudge its Offset to move the window.');
});
