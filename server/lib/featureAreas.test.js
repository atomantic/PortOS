import { describe, it, expect } from 'vitest';
import {
  FEATURE_AREAS,
  areaForNavPath,
  areasForFile,
  getFeatureArea,
  isOptionalFeatureArea,
} from './featureAreas.js';

describe('areaForNavPath', () => {
  it('prefers the longest nav path prefix over the section default', () => {
    expect(areaForNavPath('/shell/iterm')?.id).toBe('iterm');
    expect(areaForNavPath('/shell')?.id).toBe('shell');
    expect(areaForNavPath('/models/decision-classifiers/jev/try')?.id).toBe('jev');
    expect(areaForNavPath('/models/decision-classifiers')?.id).toBe('models-ai');
  });

  it('falls back to the nav command feature, then its section', () => {
    expect(areaForNavPath('/devtools/jira/reports')?.id).toBe('jira');
    expect(areaForNavPath('/meatspace/blood')?.id).toBe('health');
    expect(areaForNavPath('/devtools/github')?.id).toBe('apps-devtools');
    expect(areaForNavPath('/calendar/week')?.id).toBe('calendar');
  });

  it('ignores the query string, hash and a trailing slash', () => {
    expect(areaForNavPath('/catalog?settings=1')?.id).toBe('catalog');
    expect(areaForNavPath('/music-video/board/')?.id).toBe('music-video');
    expect(areaForNavPath('/post/morse#top')?.id).toBe('post');
  });

  it('returns null for the dashboard and for unknown paths', () => {
    expect(areaForNavPath('/')).toBeNull();
    expect(areaForNavPath('')).toBeNull();
    expect(areaForNavPath('/no-such-page')).toBeNull();
  });
});

describe('areasForFile', () => {
  it('returns the owning area for a representative file of each layer', () => {
    expect(areasForFile('server/routes/jira.js').map((entry) => entry.id)).toEqual(['jira']);
    expect(areasForFile('server/services/meatspace/meatspacePostMorse.js').map((entry) => entry.id)).toEqual(['post']);
    expect(areasForFile('server/services/meatspace/meatspaceNicotine.js').map((entry) => entry.id)).toEqual(['health']);
    expect(areasForFile('client/src/components/musicVideo/stages/AssetsStage.jsx').map((entry) => entry.id)).toEqual(['music-video']);
    expect(areasForFile('client/src/pages/MusicVideo.jsx').map((entry) => entry.id)).toEqual(['music-video']);
    expect(areasForFile('server/lib/musicDuration.js').map((entry) => entry.id)).toEqual(['music']);
  });

  it('treats a file in no area as shared code', () => {
    expect(areasForFile('package.json')).toEqual([]);
    expect(areasForFile('server/lib/objects.js')).toEqual([]);
  });

  it('accepts Windows separators', () => {
    expect(areasForFile('server\\routes\\jira.js').map((entry) => entry.id)).toEqual(['jira']);
  });
});

describe('area accessors', () => {
  it('looks areas up by id and marks only feature-backed areas optional', () => {
    expect(getFeatureArea('jira')).toBe(FEATURE_AREAS.find((entry) => entry.id === 'jira'));
    expect(getFeatureArea('missing')).toBeNull();
    expect(isOptionalFeatureArea(getFeatureArea('jira'))).toBe(true);
    expect(isOptionalFeatureArea(getFeatureArea('brain'))).toBe(false);
  });

  it('exposes frozen descriptors', () => {
    expect(Object.isFrozen(FEATURE_AREAS)).toBe(true);
    expect(Object.isFrozen(FEATURE_AREAS[0])).toBe(true);
    expect(Object.isFrozen(FEATURE_AREAS[0].codeGlobs)).toBe(true);
  });
});
