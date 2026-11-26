import { beforeAll, expect, it } from 'vitest';
import {
  installMusicVideoPageHooks, MV_ROUTES, openSettings, PROJECT_WITH_CLIP, pushSocket, savedProjectEdits, savedSceneReplies,
} from '../../test/musicVideoPageMocks.jsx';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { getMusicVideoProject, updateMusicVideoProject, updateMusicVideoScene } from '../../services/apiMusicVideo.js';
import socket from '../../services/socket.js';

installMusicVideoPageHooks();
beforeAll(async () => {
  // Keep cold lazy-module transforms out of interaction waits on a loaded test host.
  await Promise.all([
    import('./ProjectWorkspace.jsx'),
    import('./stages/PlanStage.jsx'),
    import('./stages/ProduceStage.jsx'),
    import('./ProjectSettingsDrawer.jsx'),
  ]);
});

const project = { ...PROJECT_WITH_CLIP, updatedAt: '2026-01-01T00:00:00Z' };
const boardPath = '/music-video/mv-1/board';
const shotPath = '/music-video/mv-1/produce/scene/s1';

function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Browser back</button>;
}

function renderWorkspace(path = shotPath) {
  return render(<MemoryRouter initialEntries={[path]}><HistoryBack />{MV_ROUTES}</MemoryRouter>);
}

const shotPrompt = () => screen.findByRole('textbox', { name: 'Clip prompt' });

it('shows the pending project read, then recovers a failed read on the requested stage', async () => {
  let failRead;
  getMusicVideoProject
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }))
    .mockResolvedValueOnce(project);
  renderWorkspace(boardPath);

  expect(screen.getByText('Loading projects…', { selector: 'div' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Project not found/)).toBeNull();

  await act(async () => failRead(new Error('Project storage unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Project storage unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

  const storyboard = await screen.findByRole('tab', { name: /^Storyboard/ });
  expect(storyboard).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { level: 2, name: project.name })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('restores the same shot inspector on browser back after a stage change', async () => {
  getMusicVideoProject.mockResolvedValue(project);
  renderWorkspace();
  expect(await shotPrompt()).toHaveValue(project.scenes[0].prompt);

  fireEvent.click(screen.getByRole('tab', { name: /^Storyboard/ }));
  const panel = await screen.findByRole('tabpanel', { name: 'Storyboard' });
  expect(await within(panel).findByText('Start the storyboard')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Clip prompt' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
  expect(await shotPrompt()).toHaveValue(project.scenes[0].prompt);
  expect(screen.getByRole('tab', { name: /^Shots/ })).toHaveAttribute('aria-selected', 'true');
  expect(getMusicVideoProject).toHaveBeenCalledTimes(1);
});

it('accepts pushed project changes while keeping a typed shot draft until its blur save completes', async () => {
  const fresh = {
    ...project,
    name: 'Updated project',
    updatedAt: '2026-01-01T00:00:01Z',
    scenes: [{ ...project.scenes[0], prompt: 'Prompt from the other tab' }],
  };
  socket.id = 'test-tab';
  getMusicVideoProject.mockResolvedValue(project);
  renderWorkspace();

  const prompt = await shotPrompt();
  fireEvent.change(prompt, { target: { value: 'Local draft before blur' } });
  expect(updateMusicVideoScene).not.toHaveBeenCalled();

  getMusicVideoProject.mockResolvedValueOnce(fresh);
  await pushSocket('music-video:project:changed', { id: project.id, origin: 'other-tab' });
  expect(await screen.findByRole('heading', { level: 2, name: fresh.name })).toBeInTheDocument();
  expect(prompt).toHaveValue('Local draft before blur');

  const duringSave = {
    ...fresh,
    name: 'Updated while saving',
    updatedAt: '2026-01-01T00:00:02Z',
    scenes: [{ ...fresh.scenes[0], prompt: 'Second prompt from the other tab' }],
  };
  let finishSave;
  updateMusicVideoScene.mockImplementationOnce((...args) => new Promise((resolve) => {
    finishSave = () => resolve(savedSceneReplies(duringSave)(...args));
  }));
  fireEvent.blur(prompt);
  expect(updateMusicVideoScene).toHaveBeenCalledExactlyOnceWith(project.id, 's1', { prompt: 'Local draft before blur' }, {
    silent: true,
    headers: { 'X-PortOS-Origin': 'test-tab' },
  });

  getMusicVideoProject.mockResolvedValueOnce(duringSave);
  await pushSocket('music-video:project:changed', { id: project.id, origin: 'other-tab' });
  expect(await screen.findByRole('heading', { level: 2, name: duringSave.name })).toBeInTheDocument();
  expect(await shotPrompt()).toHaveValue('Local draft before blur');
  await act(async () => finishSave());

  getMusicVideoProject.mockClear();
  await pushSocket('music-video:project:changed', { id: project.id, origin: 'test-tab' });
  expect(getMusicVideoProject).not.toHaveBeenCalled();

  getMusicVideoProject.mockResolvedValueOnce({
    ...duringSave,
    updatedAt: '2026-01-01T00:00:03Z',
    scenes: [{ ...duringSave.scenes[0], prompt: 'Remote revision after the save' }],
  });
  await pushSocket('music-video:project:changed', { id: project.id, origin: 'other-tab' });
  expect(await shotPrompt()).toHaveValue('Remote revision after the save');
});

it('shows the saved project setting from the mutation reply without rereading the project', async () => {
  getMusicVideoProject.mockResolvedValue(project);
  renderWorkspace(boardPath);
  await screen.findByRole('heading', { level: 2, name: project.name });
  await openSettings();
  const mode = screen.getByLabelText('Design and composition media');
  expect(mode).toHaveValue('code-images-video');
  updateMusicVideoProject.mockImplementationOnce(savedProjectEdits(project));

  fireEvent.change(mode, { target: { value: 'code-only' } });

  await waitFor(() => expect(mode).toHaveValue('code-only'));
  expect(updateMusicVideoProject).toHaveBeenCalledExactlyOnceWith(project.id, { mediaMode: 'code-only' }, { silent: true, edit: true });
  expect(getMusicVideoProject).toHaveBeenCalledTimes(1);
});
