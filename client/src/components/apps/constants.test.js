import { describe, it, expect } from 'vitest';
import { APP_DETAIL_TABS, appUsesJira, getAppFeatureOverride, isAppFeatureEnabled } from './constants';

const featureEntry = (id) => APP_DETAIL_TABS.find(tab => tab.id === id);

describe('appUsesJira', () => {
  it('is false for an app with no JIRA config at all', () => {
    expect(appUsesJira({ id: 'a', workTracker: 'auto' })).toBe(false);
    expect(appUsesJira({ id: 'a' })).toBe(false);
    expect(appUsesJira(null)).toBe(false);
  });

  it('is true once the integration is enabled', () => {
    expect(appUsesJira({ jira: { enabled: true } })).toBe(true);
  });

  it('is true when JIRA is the chosen work tracker, before any integration config exists', () => {
    // The bootstrap path: the JIRA tab hosts its own config panel, so this is
    // what makes the tab reachable for a never-configured app.
    expect(appUsesJira({ workTracker: 'jira' })).toBe(true);
  });

  it('is false for a disabled integration left behind by a previous setup', () => {
    expect(appUsesJira({ workTracker: 'github', jira: { enabled: false, projectKey: 'PROJ' } })).toBe(false);
  });
});

describe('managed-app feature overrides', () => {
  it('marks DataDog, JIRA, and GSD as feature-gated detail tabs', () => {
    expect(featureEntry('datadog').feature).toBe('datadog');
    expect(featureEntry('jira').feature).toBe('jira');
    expect(featureEntry('gsd').feature).toBe('gsd');
  });

  it('inherits the global setting when no app override exists', () => {
    expect(getAppFeatureOverride({ id: 'a' }, 'datadog')).toBeNull();
    expect(isAppFeatureEnabled({ id: 'a' }, 'datadog', true)).toBe(true);
    expect(isAppFeatureEnabled({ id: 'a' }, 'datadog', false)).toBe(false);
  });

  it('lets true and false app overrides outrank the global setting', () => {
    const app = { id: 'a', featureOverrides: { datadog: true, jira: false } };
    expect(isAppFeatureEnabled(app, 'datadog', false)).toBe(true);
    expect(isAppFeatureEnabled(app, 'jira', true)).toBe(false);
    expect(getAppFeatureOverride(app, 'datadog')).toBe(true);
    expect(getAppFeatureOverride(app, 'jira')).toBe(false);
  });

  it('uses a null app override to return to the global setting', () => {
    const app = { id: 'a', datadog: { enabled: true }, featureOverrides: { datadog: null } };
    expect(getAppFeatureOverride(app, 'datadog')).toBeNull();
    expect(isAppFeatureEnabled(app, 'datadog', false)).toBe(false);
  });

  it('keeps legacy integration and JIRA-tracker signals working', () => {
    expect(isAppFeatureEnabled({ datadog: { enabled: true } }, 'datadog', false)).toBe(true);
    expect(isAppFeatureEnabled({ jira: { enabled: true } }, 'jira', false)).toBe(true);
    expect(isAppFeatureEnabled({ workTracker: 'jira' }, 'jira', false)).toBe(true);
    expect(isAppFeatureEnabled({ jira: { enabled: false }, workTracker: 'github' }, 'jira', true)).toBe(false);
  });
});
