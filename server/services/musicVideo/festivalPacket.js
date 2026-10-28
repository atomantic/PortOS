import { lstat, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { requireProject } from './requireProject.js';
import { getHistoryItem } from '../videoGen/history.js';
import {
  FESTIVAL_FIELDS, FESTIVAL_NOTE_FIELDS, FESTIVAL_RIGHTS_LABELS,
  emptyFestivalPacket, festivalPacketSchema, festivalPacketText, festivalSafeText,
} from '../../lib/musicVideoFestivalPacket.js';

const unknown = () => ({ status: 'unavailable', width: null, height: null, durationSec: null });
const fileVersion = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
async function measurements(project) {
  if (!project.renderHistoryId) return unknown();
  const entry = await getHistoryItem(project.renderHistoryId);
  const path = entry?.filename && safeUnder(PATHS.videos, entry.filename);
  if (!path) return unknown();
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile()) return unknown();
  const [root, actual] = await Promise.all([realpath(PATHS.videos).catch(() => null), realpath(path).catch(() => null)]);
  if (!root || !actual?.startsWith(root + sep)) return unknown();
  const measured = await probeVideoGeometry(path).catch(() => null);
  const after = await lstat(path).catch(() => null);
  const current = await requireProject(project.id);
  const currentEntry = current.renderHistoryId ? await getHistoryItem(current.renderHistoryId) : null;
  if (!after?.isFile() || fileVersion(before) !== fileVersion(after) || current.renderHistoryId !== project.renderHistoryId || currentEntry?.filename !== entry.filename
    || ![measured?.width, measured?.height, measured?.durationSec].every(value => Number.isFinite(value) && value > 0)) return unknown();
  return { status: 'current', width: measured.width, height: measured.height, durationSec: measured.durationSec };
}

export async function getFestivalPacket(projectId) {
  const project = await requireProject(projectId);
  const packet = project.festivalPacket ? festivalPacketSchema.parse(project.festivalPacket) : emptyFestivalPacket();
  const suggestions = [
    { field: 'title', value: project.name, source: 'Project title' },
    { field: 'shortSynopsis', value: project.storySummary, source: 'Project story summary' },
  ].filter(item => typeof item.value === 'string' && item.value.length <= 12000 && item.value.trim() && festivalSafeText(item.value));
  const currentKit = !!project.renderHistoryId && project.publishKit?.master?.renderHistoryId === project.renderHistoryId;
  return { packet, fields: FESTIVAL_FIELDS, festivalFields: FESTIVAL_NOTE_FIELDS, rightsLabels: FESTIVAL_RIGHTS_LABELS,
    suggestions, measurements: unknown(),
    assets: { render: !!project.renderHistoryId, poster: !!(currentKit && project.publishKit?.coverArt?.filename),
      still: !!(currentKit && project.publishKit?.thumbnail), captions: !!(currentKit && project.publishKit?.captionsFilename) },
  };
}

export async function previewFestivalPacket(projectId, packet) {
  const project = await requireProject(projectId);
  const validated = festivalPacketSchema.parse(packet);
  const measured = await measurements(project);
  return { text: festivalPacketText(validated, measured), measurements: measured };
}
