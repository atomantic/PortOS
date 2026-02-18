/**
 * Example usage of the logger utility
 */
import * as logger from './logger.js';

// Startup message
logger.startup('Server running at http://localhost:5554');

// Processing operations
logger.process('Processing 15 items');

// Success message
logger.success('Operation completed successfully');

// Configuration updates
logger.config('Updated configuration settings');

// Feature announcements
logger.feature('New dashboard feature enabled');

// Bug reports
logger.bug('Detected memory leak in cache module');

// Information
logger.info('System health check passed');

// Warnings
logger.warning('API rate limit approaching threshold');

// Debug messages (new type added for testing)
logger.debug('Debug trace: user session initialized');

// Error messages
logger.error('Failed to connect to database');
