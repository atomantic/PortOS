import { z } from 'zod';
import { TASK_READINESS_REASONS } from './taskReadinessReasons.js';

// Validation for the server's schedule-status wire value. The shared reason
// leaf stays importable from the browser without an npm dependency.
export const taskReadinessReasonSchema = z.enum(TASK_READINESS_REASONS);
