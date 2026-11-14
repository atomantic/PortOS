import { describe, expect, it } from 'vitest';
import { hostControlGetRouteFor, isHostControlRoute } from './hostControlRoutes.js';

describe('isHostControlRoute (#16018)', () => {
  it('gates every /api write by default, whatever its family or spelling', () => {
    for (const [method, path] of [
      ['POST', '/api/apps/example-app/start'],
      ['DELETE', '/api/apps/example-app'],
      ['DELETE', '/api/auth/password'],
      ['DELETE', '/api/auth/sessions'],
      ['PUT', '/api/settings'],
      ['PATCH', '/api/brain/memories/example-id'],
      ['post', '/API/Example-New-Route/'],
      ['PROPFIND', '/api/example'],
      ['POST', '/api//runs'],
      ['POST', '/api'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(true);
  });

  it('leaves writes outside /api to their own routers', () => {
    expect(isHostControlRoute('POST', '/sdapi/v1/txt2img')).toBe(false);
    expect(isHostControlRoute('POST', '/apix/example')).toBe(false);
  });

  it('opens only the public, peer, bootstrap, broker and exposed-API surfaces, in any case', () => {
    for (const [method, path] of [
      ['POST', '/api/auth/login'],
      ['POST', '/API/Auth/Logout/'],
      ['POST', '/api/peer-sync/push'],
      ['POST', '/api/Peer-Sync/Push/'],
      ['POST', '/api/instances/peers/announce'],
      ['POST', '/api/instances/peers/pair-secret'],
      ['POST', '/api/federation/media/v1/jobs'],
      ['POST', '/api/managed-visitors/v1/admissions'],
      ['POST', '/api/voice/public/synthesize'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });

  it('keeps a peer surface to its listed methods and refuses ambiguous spellings', () => {
    // The surface admits only GET here, and only POST on the push.
    expect(isHostControlRoute('DELETE', '/api/peer-sync/manifest')).toBe(true);
    expect(isHostControlRoute('PUT', '/api/peer-sync/push')).toBe(true);
    // A prefix match cannot be argued past by a path a later layer normalizes.
    expect(isHostControlRoute('POST', '/api/federation/media/v1/../../apps/example/start')).toBe(true);
    expect(isHostControlRoute('POST', '/api/federation/media/v1/%2e%2e/apps')).toBe(true);
    // Neighbours of an exact public path are not public.
    expect(isHostControlRoute('POST', '/api/auth/login-example')).toBe(true);
    expect(isHostControlRoute('POST', '/api/managed-visitors/v10/admissions')).toBe(true);
    expect(isHostControlRoute('POST', '/api/voice/publicity')).toBe(true);
  });

  it('opens reads except the listed sensitive GETs, which HEAD follows', () => {
    expect(isHostControlRoute('GET', '/api/apps')).toBe(false);
    expect(isHostControlRoute('OPTIONS', '/api/apps')).toBe(false);
    expect(isHostControlRoute('GET', '/api/scaffold/templates')).toBe(false);
    expect(isHostControlRoute('GET', '/api/scaffold/directories')).toBe(true);
    expect(isHostControlRoute('HEAD', '/API/Scaffold/Directories//')).toBe(true);
    expect(hostControlGetRouteFor('GET', '/api/browser/downloads/example.zip')).toBe('GET /api/browser/downloads/:name');
    expect(hostControlGetRouteFor('GET', '/api/browser/downloads/example.zip/extra')).toBeNull();
    expect(hostControlGetRouteFor('POST', '/api/scaffold/directories')).toBeNull();
  });
});
