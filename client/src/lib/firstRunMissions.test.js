import { describe, expect, it } from 'vitest';
import {
  FIRST_RUN_HIDE_SETTING,
  FIRST_RUN_MISSIONS,
  FIRST_RUN_PATH,
  FIRST_RUN_QUERY_PARAM,
  featuresToEnable,
  parseFirstRunQueryParam,
  shouldShowFirstRunCard,
} from './firstRunMissions.js';

describe('firstRunMissions data', () => {
  it('stages the four PortOS slices on their natural entry points', () => {
    expect(FIRST_RUN_MISSIONS.map((m) => [m.id, m.to])).toEqual([
      ['creative-studio', '/start-story'],
      ['personal-knowledge', '/brain/inbox'],
      ['run-my-machines', '/apps'],
      ['delegate-work', '/cos/tasks'],
    ]);
  });

  it('only names known Settings → Features ids, never auto-detected integrations', () => {
    const ids = FIRST_RUN_MISSIONS.flatMap((m) => m.features);
    expect(ids.sort()).toEqual(['gsd', 'health', 'openclaw']);
    expect(ids).not.toContain('datadog');
    expect(ids).not.toContain('jira');
    expect(ids).not.toContain('eidoverse');
    expect(ids).not.toContain('facetime');
    expect(ids).not.toContain('post');
  });

  it('keeps the query-param and durable-setting names stable', () => {
    expect(FIRST_RUN_QUERY_PARAM).toBe('firstRun');
    expect(FIRST_RUN_HIDE_SETTING).toBe('hideFirstRunCard');
    expect(FIRST_RUN_PATH).toBe('/');
  });
});

describe('parseFirstRunQueryParam', () => {
  it('forces on/off from the demonstration contract and ignores anything else', () => {
    expect(parseFirstRunQueryParam('1')).toBe(true);
    expect(parseFirstRunQueryParam('on')).toBe(true);
    expect(parseFirstRunQueryParam('TRUE')).toBe(true);
    expect(parseFirstRunQueryParam('0')).toBe(false);
    expect(parseFirstRunQueryParam('off')).toBe(false);
    expect(parseFirstRunQueryParam('false')).toBe(false);
    expect(parseFirstRunQueryParam(null)).toBe(null);
    expect(parseFirstRunQueryParam('')).toBe(null);
    expect(parseFirstRunQueryParam('maybe')).toBe(null);
  });
});

describe('featuresToEnable', () => {
  const knowledge = FIRST_RUN_MISSIONS.find((m) => m.id === 'personal-knowledge');
  const creative = FIRST_RUN_MISSIONS.find((m) => m.id === 'creative-studio');

  it('writes only matching features that are not already on', () => {
    expect(featuresToEnable(knowledge, [{ id: 'health', enabled: false }])).toEqual(['health']);
    expect(featuresToEnable(knowledge, [{ id: 'health', enabled: true }])).toEqual([]);
    expect(featuresToEnable(knowledge, [])).toEqual(['health']);
    expect(featuresToEnable(creative, [{ id: 'health', enabled: false }])).toEqual([]);
  });
});

describe('shouldShowFirstRunCard', () => {
  const shown = {
    pathname: '/',
    queryForce: null,
    settingsLoaded: true,
    hideSetting: false,
    sessionDismissed: false,
  };

  it('shows on / once settings have loaded and nothing has dismissed it', () => {
    expect(shouldShowFirstRunCard(shown)).toBe(true);
  });

  it('never shows off the dashboard index (deep links / ⌘K / voice ui_navigate)', () => {
    expect(shouldShowFirstRunCard({ ...shown, pathname: '/apps' })).toBe(false);
    expect(shouldShowFirstRunCard({ ...shown, pathname: '/start-story' })).toBe(false);
    expect(shouldShowFirstRunCard({ ...shown, pathname: '/brain/inbox' })).toBe(false);
    expect(shouldShowFirstRunCard({ ...shown, pathname: '/cos/tasks' })).toBe(false);
  });

  it('hides until the durable setting has been read, so a suppressed install does not flash', () => {
    expect(shouldShowFirstRunCard({ ...shown, settingsLoaded: false })).toBe(false);
  });

  it('hides for a durable suppress and for a session dismiss', () => {
    expect(shouldShowFirstRunCard({ ...shown, hideSetting: true })).toBe(false);
    expect(shouldShowFirstRunCard({ ...shown, sessionDismissed: true })).toBe(false);
  });

  it('lets ?firstRun= force on or off without inventing extra persistence', () => {
    expect(shouldShowFirstRunCard({ ...shown, hideSetting: true, queryForce: true })).toBe(true);
    expect(shouldShowFirstRunCard({ ...shown, sessionDismissed: true, queryForce: true })).toBe(true);
    expect(shouldShowFirstRunCard({ ...shown, queryForce: false })).toBe(false);
    expect(shouldShowFirstRunCard({ ...shown, pathname: '/apps', queryForce: true })).toBe(false);
  });
});
