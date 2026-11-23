/**
 * Process pins for Cast & Sets and autonomous runs.
 *
 * A working stage or run records the server process that may dispatch for it.
 * Only this process knows its own id, so only the server can tell a restart
 * (`interrupted`) from work still running here. The helpers are read-time only:
 * never persist their result. They live here so a project read does not load
 * the stage orchestrators or the autonomous execution graph (#17576).
 */

import { randomUUID } from 'node:crypto';
import { presentCastAndSets } from './castAndSets.js';

export const CAST_SETS_PROCESS_ID = `proc-${randomUUID()}`;
export const AUTONOMOUS_PROCESS_ID = `proc-${randomUUID()}`;

/** Test seam: this process's Cast & Sets pin. */
export const __castAndSetsProcessId = () => CAST_SETS_PROCESS_ID;

/** The run as the client sees it: `interrupted` when it was pinned to a previous server process. */
export const presentAutonomousRun = (run) => (run
  ? { ...run, interrupted: run.status === 'running' && run.processId !== AUTONOMOUS_PROCESS_ID }
  : null);

/** `presentAutonomousRun` for a project read; reader-only — never persist the result. */
export const presentProjectAutonomousRun = (project) => (project?.autonomousRun
  ? { ...project, autonomousRun: presentAutonomousRun(project.autonomousRun) }
  : project);

/** Test seam: this process's autonomous-run pin. */
export const __autonomousProcessId = () => AUTONOMOUS_PROCESS_ID;

/**
 * The project as a client reads its Cast & Sets stage. Not for write paths —
 * never persist the result.
 */
export const presentProjectCastAndSets = (project) => (project?.castAndSets
  ? { ...project, castAndSets: presentCastAndSets(project.castAndSets, CAST_SETS_PROCESS_ID) }
  : project);
