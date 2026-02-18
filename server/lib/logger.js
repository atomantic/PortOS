/**
 * Logging utility with emoji prefixes
 * Follows PortOS single-line logging conventions
 */

/**
 * Server startup and initialization
 * @param {string} message - Log message
 */
export const startup = (message) => {
  console.log(`🚀 ${message}`);
};

/**
 * Processing operations
 * @param {string} message - Log message
 */
export const process = (message) => {
  console.log(`📜 ${message}`);
};

/**
 * Error messages
 * @param {string} message - Error message
 */
export const error = (message) => {
  console.error(`❌ ${message}`);
};

/**
 * Success messages
 * @param {string} message - Success message
 */
export const success = (message) => {
  console.log(`✅ ${message}`);
};

/**
 * Configuration and setup
 * @param {string} message - Config message
 */
export const config = (message) => {
  console.log(`🔧 ${message}`);
};

/**
 * New feature or celebration
 * @param {string} message - Feature message
 */
export const feature = (message) => {
  console.log(`🎉 ${message}`);
};

/**
 * Bug or issue detection
 * @param {string} message - Bug message
 */
export const bug = (message) => {
  console.log(`🐛 ${message}`);
};

/**
 * Information or announcement
 * @param {string} message - Info message
 */
export const info = (message) => {
  console.log(`ℹ️ ${message}`);
};

/**
 * Warning messages
 * @param {string} message - Warning message
 */
export const warning = (message) => {
  console.warn(`⚠️ ${message}`);
};

/**
 * Debug information (new innocuous type for testing)
 * @param {string} message - Debug message
 */
export const debug = (message) => {
  console.log(`🔍 ${message}`);
};
