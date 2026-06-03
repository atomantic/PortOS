/**
 * Task Learning Service
 *
 * Tracks patterns from completed tasks to improve future task execution.
 * Learns from success/failure rates, duration patterns, and error categories
 * to provide smarter task prioritization and model selection.
 *
 * The implementation lives in `./taskLearning/` (split by concern: store,
 * metrics, routing, durations, insights, prompt recommendations, lifecycle).
 * This file is a stable barrel that preserves the original public API so
 * every importer of `./taskLearning.js` keeps working unchanged.
 */

export * from './taskLearning/index.js';
