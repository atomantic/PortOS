// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe.skipIf(!chrome)('AgentCard touch targets in Chromium', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'agent-card-touch-13925', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/cos/tabs/AgentCard.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'agent-card-touch-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/agent-card-touch-fixture.jsx') return '\0agent-card-touch-fixture.jsx';
            if (id === '../../../services/api') return '\0agent-card-touch-api';
            if (id === '../../../services/socket') return '\0agent-card-touch-socket';
            if (id === '../../../lib/clipboard') return '\0agent-card-touch-clipboard';
            if (id === '../../ui/Toast') return '\0agent-card-touch-toast';
          },
          load(id) {
            if (id === '\0agent-card-touch-api') return `export const getCosAgentStats = async () => null; export const getCosAgent = async () => ({output:[]}); export const getCosAgentPrompt = async () => null; export const hydrateCosAgentDescription = async agent => agent; export const normalizeBrainScanReportPath = path => path; export const submitCosAgentFeedback = async () => ({success:true}); export const sendCosAgentBtw = async () => ({success:true}); export const addCosTask = async () => ({success:true});`;
            if (id === '\0agent-card-touch-socket') return `export default {on(){},off(){},emit(){}};`;
            if (id === '\0agent-card-touch-clipboard') return `export const copyToClipboard = async () => true;`;
            if (id === '\0agent-card-touch-toast') return `export default {success(){},error(){}};`;
            if (id !== '\0agent-card-touch-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import AgentCard from '/src/components/cos/tabs/AgentCard.jsx';
              import '/src/index.css';
              const now = new Date().toISOString();
              const base = {id:'touch-agent',taskId:'touch-task',status:'running',startedAt:now,completedAt:null,metadata:{taskDescription:'Synthetic task'},result:null,output:['Working']};
              window.actions = [];
              const action = name => value => window.actions.push({name,id:typeof value === 'string' ? value : value.id});
              createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,
                React.createElement('main',{className:'w-full max-w-full p-2'},
                  React.createElement(AgentCard,{agent:base,liveOutput:[{line:'Working'}],onRelaunch:action('relaunch'),onPause:action('pause'),onKill:action('kill')}),
                  React.createElement(AgentCard,{agent:{...base,id:'paused-agent',status:'paused'},paused:true,onResume:action('resume')}),
                  React.createElement(AgentCard,{agent:{...base,id:'completed-agent',status:'completed',completedAt:now},completed:true,onResume:action('resume')}))));`;
          },
          configureServer(vite) {
            vite.middlewares.use('/agent-card-touch-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/agent-card-touch-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/agent-card-touch-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it.each([360, 768, 1024])('keeps separate action targets at %i px', async width => {
    const context = await fixture.browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${fixture.origin}agent-card-touch-test`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Show' }).first().waitFor({ state: 'attached' });
      const session = await context.newCDPSession(page);
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
      const expected = ['Show', "Relaunch this agent's task on a different provider or model", 'Pause agent and preserve worktree', 'Force kill agent (SIGKILL)', "Resume this agent's task on its preserved worktree", "Create new task from this agent's context"];
      for (const label of expected) {
        const button = page.getByRole('button', { name: label }).first();
        const box = await button.boundingBox();
        const card = await button.locator('xpath=ancestor::div[contains(@class,"bg-port-card")]').boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect(box?.x).toBeGreaterThanOrEqual(card.x);
        expect(box?.y).toBeGreaterThanOrEqual(card.y);
        expect(box?.x + box.width).toBeLessThanOrEqual(card.x + card.width);
        expect(box?.y + box.height).toBeLessThanOrEqual(card.y + card.height);
        const receivesCenterTap = await button.evaluate((element, point) =>
          document.elementFromPoint(point.x, point.y)?.closest('button') === element,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        expect(receivesCenterTap).toBe(true);
      }
      await page.getByRole('button', { name: 'Show' }).first().click();
      await page.getByRole('button', { name: 'Hide' }).first().waitFor({ state: 'visible' });
      await page.getByRole('button', { name: "Relaunch this agent's task on a different provider or model" }).click();
      await page.getByRole('button', { name: 'Force kill agent (SIGKILL)' }).click();
      for (const label of ['Confirm', 'Cancel']) {
        const box = await page.getByRole('button', { name: label }).boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Pause agent and preserve worktree' }).click();
      await page.getByRole('button', { name: "Resume this agent's task on its preserved worktree" }).click();
      await page.getByRole('button', { name: "Create new task from this agent's context" }).click();
      expect(await page.evaluate(() => window.actions)).toEqual([
        { name: 'relaunch', id: 'touch-agent' },
        { name: 'pause', id: 'touch-agent' },
        { name: 'resume', id: 'paused-agent' },
        { name: 'resume', id: 'completed-agent' },
      ]);
    } finally { await context.close(); }
  });
});
