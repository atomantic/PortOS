/**
 * Bounded execution-option definitions, validation, precedence and requested/effective attribution.
 */

export {
  EXECUTION_OPTIONS_VERSION, EXECUTION_OPTIONS_ERROR, executionOptionsError, EXECUTION_OPTION_DEFINITIONS,
  validateExecutionOptions, resolveExecutionOptions, taskExecutionOptions,
} from './aiToolkit/internal/executionOptions.js';
