/**
 * Open a shot's saved scene (renders/<shot>/shot.blend, written when "save
 * .blend" is on) in the Blender application, with the operator-checked
 * executable. The file is the film's own build; scripts embedded in it stay off.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { launchDetached } from '../../../lib/launchDetached.js';
import { requireProject } from '../requireProject.js';
import { assertInsideWithoutSymlinks, blenderRefusal, blenderShotDir, blenderWorkspaceDir } from './workspace.js';

export async function openBlenderShot(projectId, shotId) {
  await requireProject(projectId);
  const blend = join(blenderShotDir(projectId, shotId), 'shot.blend');
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(projectId), blend);
  const info = await lstat(blend).catch(() => null);
  if (!info?.isFile()) {
    throw blenderRefusal('This shot has no saved .blend. Turn on "Save .blend" in the film settings and render the shot again.', 'MUSIC_VIDEO_BLENDER_NO_BLEND', 404);
  }
  const { resolveBlenderTool } = await import('../../codeAnimation/execution.js');
  const tool = await resolveBlenderTool();
  await launchDetached(tool.executable, ['--disable-autoexec', blend]).catch((error) => {
    throw blenderRefusal(`Blender did not start: ${error.message}`, 'MUSIC_VIDEO_BLENDER_OPEN_FAILED', 500);
  });
  console.log(`🧊 Opened Blender film shot ${shotId} of ${projectId.slice(0, 11)} in Blender ${tool.version}`);
  return { opened: true, blenderVersion: tool.version };
}
