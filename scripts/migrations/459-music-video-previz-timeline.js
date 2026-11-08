/**
 * The music video previz stops hard-coding one story: `previz.night` becomes
 * `previz.timeline`, and "riding" is no longer a bike but a vehicle, a cast
 * object listed in `previz.vehicles`. Frozen transform (no live service code):
 *
 * - `night` is renamed `timeline`.
 * - A project that rode (a beat with pace `ride`, a track key with pose `ride`)
 *   gets a vehicle: its existing bike-like object, else a new local-only "Bike"
 *   object (when the cast has room). The beats and keys name it, the legacy
 *   `bike` pawn color becomes that object's color, and `pace: 'ride'` becomes walk.
 * - Without room for a vehicle object, riding is dropped to standing.
 *
 * Idempotent: a previz already in the new shape is returned unchanged.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

const SUBJECTS_MAX = 24;
const VEHICLE_ID = 'mv-vehicle-bike';
const VEHICLE_SPEED = 270;
const BIKE_NAME = /\b(bikes?|bicycles?|cycl\w*)\b/i;

const hasLegacyShape = (previz) => !!previz && typeof previz === 'object'
  && (Object.hasOwn(previz, 'night') || Object.values(previz.pawnColors || {}).some((entry) => entry && Object.hasOwn(entry, 'bike')));

export function migrateMusicVideoPreviz(record) {
  const previz = record?.previz;
  if (!hasLegacyShape(previz)) return record;
  const { night, pawnColors, ...rest } = previz;
  const beats = night?.beats || [];
  const rides = beats.some((beat) => beat.pace === 'ride') || (previz.tracks || []).some((track) => (track.keys || []).some((key) => key.pose === 'ride'));
  const subjects = record.concept?.subjects || [];
  let vehicleId = null;
  let createdSubject = null;
  if (rides) {
    vehicleId = subjects.find((subject) => subject?.kind === 'object' && BIKE_NAME.test(subject.name || ''))?.id || null;
    if (!vehicleId && subjects.length < SUBJECTS_MAX) {
      createdSubject = { id: VEHICLE_ID, kind: 'object', name: 'Bike', localOnly: true };
      vehicleId = VEHICLE_ID;
    }
  }
  // The first rider's explicit bike color becomes the vehicle's color.
  const bikeColor = Object.values(pawnColors || {}).map((entry) => entry?.bike).find(Boolean);
  const nextColors = Object.fromEntries(Object.entries(pawnColors || {}).map(([id, entry]) => {
    const { bike, ...kept } = entry || {};
    return [id, kept];
  }));
  if (vehicleId && bikeColor) nextColors[vehicleId] = { ...nextColors[vehicleId], figure: bikeColor };
  const ridden = (pose) => (pose === 'ride' ? (vehicleId ? { pose, vehicleSubjectId: vehicleId } : { pose: 'stand' }) : {});
  const next = {
    ...rest,
    ...(Object.keys(nextColors).length || pawnColors ? { pawnColors: nextColors } : {}),
    ...(rest.tracks ? { tracks: rest.tracks.map((track) => ({ ...track, keys: (track.keys || []).map((key) => ({ ...key, ...ridden(key.pose) })) })) } : {}),
    ...(vehicleId ? { vehicles: [...(rest.vehicles || []), ...(rest.vehicles?.some((entry) => entry.subjectId === vehicleId) ? [] : [{ subjectId: vehicleId, speedMetersPerMin: VEHICLE_SPEED }])] } : {}),
    ...(night ? {
      timeline: {
        ...night,
        beats: beats.map(({ pace, ...beat }) => (pace === 'ride'
          ? { ...beat, pace: 'walk', ...(vehicleId ? { vehicleSubjectId: vehicleId } : {}) }
          : { ...beat, ...(pace !== undefined ? { pace } : {}) })),
      },
    } : {}),
  };
  const concept = createdSubject ? { ...record.concept, subjects: [...subjects, createdSubject] } : record.concept;
  return { ...record, ...(concept ? { concept } : {}), previz: next };
}

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'music-video-projects.json');
    const raw = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (raw) {
      const records = JSON.parse(raw);
      if (!Array.isArray(records)) throw new Error('Music Video project file must contain an array');
      await writeJsonAtomic(file, records.map(migrateMusicVideoPreviz));
    }
    // Postgres rows are converted by db-migration 031, which runs under the DB runner.
    return { success: true };
  },
};
