import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as logger from './logger.js';

describe('logger', () => {
  let consoleLogSpy;
  let consoleErrorSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('startup logs with rocket emoji', () => {
    logger.startup('Server started');
    expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Server started');
  });

  test('process logs with scroll emoji', () => {
    logger.process('Processing 5 items');
    expect(consoleLogSpy).toHaveBeenCalledWith('📜 Processing 5 items');
  });

  test('error logs with cross emoji', () => {
    logger.error('Failed to connect');
    expect(consoleErrorSpy).toHaveBeenCalledWith('❌ Failed to connect');
  });

  test('success logs with check emoji', () => {
    logger.success('Operation completed');
    expect(consoleLogSpy).toHaveBeenCalledWith('✅ Operation completed');
  });

  test('config logs with wrench emoji', () => {
    logger.config('Configuration updated');
    expect(consoleLogSpy).toHaveBeenCalledWith('🔧 Configuration updated');
  });

  test('feature logs with party emoji', () => {
    logger.feature('New feature enabled');
    expect(consoleLogSpy).toHaveBeenCalledWith('🎉 New feature enabled');
  });

  test('bug logs with bug emoji', () => {
    logger.bug('Bug detected in module');
    expect(consoleLogSpy).toHaveBeenCalledWith('🐛 Bug detected in module');
  });

  test('info logs with info emoji', () => {
    logger.info('System information');
    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️ System information');
  });

  test('warning logs with warning emoji', () => {
    logger.warning('Deprecation warning');
    expect(consoleWarnSpy).toHaveBeenCalledWith('⚠️ Deprecation warning');
  });

  test('debug logs with magnifying glass emoji (new type)', () => {
    logger.debug('Debug trace information');
    expect(consoleLogSpy).toHaveBeenCalledWith('🔍 Debug trace information');
  });
});
