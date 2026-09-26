/**
 * Writers Room presets — re-export of server/lib/writersRoomPresets.js.
 *
 * The client and server share the work kind and status enums so they cannot drift.
 * The file stays so every `client/src/lib/writersRoomPresets` import path is unchanged.
 */
export { WORK_KINDS, WORK_STATUSES, EXERCISE_STATUSES, ANALYSIS_KINDS } from '../../../server/lib/writersRoomPresets.js';
