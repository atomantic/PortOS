/**
 * #16428 (a-c): every `GET`/`DELETE`/`PUT` handler in the route files starting a-c that reads `req.query`
 * refuses a malformed query with 400 before reaching its service. A repeated key (`?k=a&k=b`, an
 * array in Express) is the malformed shape for optional string fields; the agent routes also
 * refuse a missing required key. Unknown keys must stay ignored, and the routers are loaded
 * lazily so the suite's static import closure stays at the harness.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// `loadApp` reads the apps store before the handler runs; this suite only cares about the handler's query check.
vi.mock('./apps/shared.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadApp: (req, _res, next) => { req.loadedApp = { id: 'app-1' }; next(); },
}));

const CASES = [
  ['./agentPersonalities.js', 'get', '/?userId=a&userId=b'],
  ['./agentTools.js', 'get', '/submolts'],
  ['./agentTools.js', 'get', '/post/p1'],
  ['./agentTools.js', 'get', '/rate-limits'],
  ['./agentTools.js', 'get', '/published?agentId=a'],
  ['./agentTools.js', 'get', '/drafts'],
  ['./agentTools.js', 'put', '/drafts/d1', {}],
  ['./agentTools.js', 'delete', '/drafts/d1'],
  ['./albums.js', 'get', '/?limit=1&limit=2'],
  ['./appleHealth.js', 'get', '/metrics/steps?from=a&from=b'],
  ['./appleHealth.js', 'get', '/metrics/steps/daily?to=a&to=b'],
  ['./appleHealth.js', 'get', '/correlation?from=a&from=b'],
  ['./apps/agents.js', 'get', '/app-1/agents?limit=1&limit=2'],
  ['./artists.js', 'get', '/?offset=1&offset=2'],
  ['./authors.js', 'get', '/?limit=1&limit=2'],
  ['./automationSchedules.js', 'get', '/?agentId=a&agentId=b'],
  ['./avatar.js', 'get', '/model.glb?variant=a&variant=b'],
  ['./brainCrud.js', 'get', '/admin?status=a&status=b'],
  ['./brainCrud.js', 'get', '/ideas?status=a&status=b'],
  ['./brainCrud.js', 'get', '/projects?status=a&status=b'],
  ['./brainDailyLog.js', 'get', '/daily-log?includeContent=1&includeContent=0'],
  ['./brainDigest.js', 'get', '/digests?limit=1&limit=2'],
  ['./brainDigest.js', 'get', '/reviews?limit=1&limit=2'],
  ['./brainImport.js', 'get', '/chatgpt/archive/x?preview=a&preview=b'],
  ['./brainOnThisDay.js', 'get', '/on-this-day?limit=1&limit=2'],
  ['./browser.js', 'get', '/downloads/x?attachment=1&attachment=0'],
  ['./calendar.js', 'get', '/agenda?limit=1&limit=2'],
  ['./calendar.js', 'get', '/events?search=a&search=b'],
  ['./catalog.js', 'delete', '/types/t1?force=true&force=false'],
  ['./catalog.js', 'get', '/ingredients/i1?includeEmbedding=true&includeEmbedding=false'],
  ['./catalog.js', 'get', '/scraps?limit=1&limit=2'],
  ['./catalog.js', 'get', '/sync?limit=1&limit=2'],
  ['./codeAnimation.js', 'get', '/projects?limit=1&limit=2'],
  ['./codeAnimation.js', 'get', '/projects/00000000-0000-4000-8000-000000000000/history?limit=1&limit=2'],
  ['./cosInsightRoutes.js', 'get', '/activity-calendar?weeks=1&weeks=2'],
  ['./cosInsightRoutes.js', 'get', '/recent-tasks?limit=1&limit=2'],
  ['./cosLearningRoutes.js', 'get', '/learning/insights?limit=1&limit=2'],
  ['./cosScheduleRoutes.js', 'get', '/upcoming?limit=1&limit=2'],
  ['./cosTemplateRoutes.js', 'get', '/templates/popular?limit=1&limit=2'],
  ['./cosWorkflowRoutes.js', 'get', '/workflow?hours=24&hours=168'],
  ['./creativeCommissions.js', 'get', '/?limit=1&limit=2'],
  ['./creativeDirector.js', 'get', '/cd-1?slim=1&slim=0'],
  ['./pipeline/covers.js', 'get', '/issues/i1/comic.pdf?size=a4&size=tabloid'],
  ['./pipeline/covers.js', 'get', '/series/s1/seasons/n1/volume.pdf?size=a4&size=tabloid'],
  ['./universeBuilder/canon.js', 'get', '/u1/characters/integrity?characterIds=a&characterIds=b'],
  ['./universeBuilder/crud.js', 'get', '/?limit=1&limit=2'],
];

describe('malformed req.query is refused with 400 (#16428, a-c)', () => {
  it.each(CASES)('%s %s %s', async (file, method, url, body) => {
    const { default: router } = await import(file);
    const app = express();
    app.use(express.json());
    app.use('/', router);
    app.use(errorMiddleware);
    const res = await request(app)[method](url).send(body);
    expect(res.status).toBe(400);
  }, 30000);
});
