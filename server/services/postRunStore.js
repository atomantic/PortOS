/**
 * Normalized POST run store dispatcher (#4441).
 * PostgreSQL is authoritative in normal installs; the legacy JSON layout stays
 * as the development/test escape hatch so existing focused suites need no DB.
 */

import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import {
  getScoredSession as getScoredSessionDb,
  listScoredSessions as listScoredSessionsDb,
  listTrainingEntries as listTrainingEntriesDb,
  saveNormalizedRun,
} from './postRunDb.js';

const MEATSPACE_DIR = PATHS.meatspace;
const SESSIONS_FILE = join(MEATSPACE_DIR, 'post-sessions.json');
const TRAINING_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

async function loadFileSessions({ strict = false } = {}) {
  const raw = await readJSONFile(SESSIONS_FILE, { sessions: [] }, { allowArray: false, strict });
  if (strict && (!isPlainObject(raw) || !Array.isArray(raw.sessions))) {
    throw new Error(`POST sessions malformed: ${SESSIONS_FILE}`);
  }
  return Array.isArray(raw?.sessions) ? raw.sessions : [];
}

async function loadFileTraining({ strict = false } = {}) {
  const raw = await readJSONFile(TRAINING_FILE, { entries: [] }, { allowArray: false, strict });
  if (strict && !Array.isArray(raw?.entries)) {
    throw new Error(`POST training log malformed: ${TRAINING_FILE}`);
  }
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

function makeFileBackend() {
  return {
    name: 'file',
    listScoredSessions: loadFileSessions,
    getScoredSession: async (id) => (await loadFileSessions()).find((session) => session.id === id) || null,
    saveScoredSession: async (session) => {
      const sessions = await loadFileSessions();
      const index = sessions.findIndex((item) => item.id === session.id);
      const existing = index >= 0 ? sessions[index] : null;
      const persisted = {
        ...session,
        date: existing?.date ?? session.date,
        startedAt: existing?.startedAt ?? session.startedAt,
      };
      if (index >= 0) sessions[index] = persisted;
      else sessions.push(persisted);
      sessions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      await ensureDir(MEATSPACE_DIR);
      await atomicWrite(SESSIONS_FILE, { sessions });
      return { session: persisted, isNew: index < 0 };
    },
    listTrainingEntries: loadFileTraining,
    saveTrainingRun: async (run) => {
      const entries = await loadFileTraining();
      const prior = new Map(entries.filter((entry) => entry.runId === run.id).map((entry) => [entry.id, entry]));
      const incomingIds = new Set(run.attempts.map((attempt) => attempt.id));
      const foreign = entries.find((entry) => entry.runId !== run.id && incomingIds.has(entry.id));
      if (foreign) throw new Error(`POST attempt ${foreign.id} already belongs to another run`);
      const firstPrior = prior.values().next().value;
      const persistedRun = prior.size
        ? {
            ...run,
            localDay: firstPrior.date || run.localDay,
            startedAt: firstPrior.timestamp || run.startedAt,
          }
        : run;
      const next = entries.filter((entry) => entry.runId !== run.id);
      for (const attempt of persistedRun.attempts) {
        const old = prior.get(attempt.id);
        next.push({
          ...(attempt.data || {}),
          id: attempt.id,
          runId: persistedRun.id,
          date: old?.date ?? persistedRun.localDay,
          timestamp: old?.timestamp ?? persistedRun.startedAt,
        });
      }
      await ensureDir(MEATSPACE_DIR);
      await atomicWrite(TRAINING_FILE, { entries: next });
      return { run: persistedRun, isNew: prior.size === 0 };
    },
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    listScoredSessions: (options) => listScoredSessionsDb(db, options),
    getScoredSession: (id) => getScoredSessionDb(db, id),
    saveScoredSession: async (session) => {
      const result = await saveNormalizedRun(db, scoredSessionRun(session));
      return { session: result.run.data, isNew: result.isNew };
    },
    listTrainingEntries: (options) => listTrainingEntriesDb(db, options),
    saveTrainingRun: (run) => saveNormalizedRun(db, run),
  };
}

const pgBackend = () => resolvePgBackend({
  requirement: 'MeatSpace POST history requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file)',
  migrate: async () => {
    const { migratePostRunsToDB } = await import('../scripts/migratePostRunsToDB.js');
    await migratePostRunsToDB();
  },
  loadDb: () => import('../lib/db.js'),
  makePg: makePgBackend,
});

const facade = createPgFileFacade({
  // Vitest's VITEST marker is the resilient test signal when a wrapper drops
  // NODE_ENV; never let a focused suite fall through to the live Postgres DB.
  isFile: () => process.env.MEMORY_BACKEND === 'file' || isTestRunner(),
  makeFile: makeFileBackend,
  makePg: pgBackend,
});
const backend = facade.getBackend;

function scoredTaskAttempt(sessionId, task, position) {
  const questions = Array.isArray(task.questions) ? task.questions : [];
  const answered = questions.filter((question) => question?.answered != null);
  return {
    id: task.id || `${sessionId}:attempt:${position}`,
    module: task.module,
    drillType: task.type,
    difficulty: task.config || null,
    configVersion: task.configVersion || null,
    correct: answered.length ? answered.every((question) => question.correct === true) : null,
    score: task.score ?? null,
    latencyMs: task.totalMs || 0,
    completion: task.completion ?? (questions.length ? answered.length / questions.length : null),
    hintUsed: questions.some((question) => question?.hintUsed === true),
    confidence: task.confidence ?? null,
    inputMode: task.inputMode || 'unknown',
    scorerProvenance: task.scorerProvenance || 'post-server',
    data: task,
    legacy: task.legacy === true,
  };
}

export function scoredSessionRun(session) {
  return {
    id: session.id,
    mode: 'test',
    localDay: session.date,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    status: 'completed',
    planned: { cadence: session.cadence, modules: session.modules },
    data: session,
    legacy: session.legacy === true,
    attempts: (session.tasks || []).map((task, position) => scoredTaskAttempt(session.id, task, position)),
  };
}

export async function listPostSessions(options) {
  return (await backend()).listScoredSessions(options);
}

export async function getStoredPostSession(id) {
  return (await backend()).getScoredSession(id);
}

export async function saveStoredPostSession(session) {
  return (await backend()).saveScoredSession(session);
}

export async function listStoredTrainingEntries(options) {
  return (await backend()).listTrainingEntries(options);
}

export async function saveStoredTrainingRun(run) {
  return (await backend()).saveTrainingRun(run);
}

export function _resetPostRunBackend() {
  facade.reset();
}
