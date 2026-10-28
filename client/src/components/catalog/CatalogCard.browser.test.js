// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../..', import.meta.url));

describe.skipIf(!chrome)('Catalog card selection target geometry (#13926)', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'catalog-card-selection-target', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/catalog/CatalogCard.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'catalog-card-selection-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/catalog-card-fixture.jsx') return '\0catalog-card-fixture.jsx';
            if (/\/components\/MediaImage(?:\.jsx)?$/.test(id)) return '\0catalog-card-media';
            if (/\/components\/catalog\/CatalogImageAction(?:\.jsx)?$/.test(id)) return '\0catalog-card-image-action';
          },
          load(id) {
            if (id === '\0catalog-card-media') return 'export default function MediaImage(){return null}';
            if (id === '\0catalog-card-image-action') return 'export default function CatalogImageAction(){return null}';
            if (id !== '\0catalog-card-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter, useLocation } from 'react-router';
              import CatalogCard from '/src/components/catalog/CatalogCard.jsx';
              import '/src/index.css';
              function Fixture(){
                const [selected, setSelected] = React.useState(false);
                const location = useLocation();
                const type = () => ({label:'Character', badgeColor:'border-gray-500'});
                return React.createElement(React.Fragment, null,
                  React.createElement(CatalogCard, {ingredient:{id:'fixture-1',name:'Synthetic Card',type:'character',payload:{},tags:[]},getType:type,selected,onToggleSelect:()=>setSelected(value=>!value),armed:false,onArm:()=>{},onCancelArm:()=>{},onConfirmDelete:()=>{}}),
                  React.createElement('output', {'data-testid':'selected'}, String(selected)),
                  React.createElement('output', {'data-testid':'location'}, location.pathname));
              }
              createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter, {initialEntries:['/catalog']}, React.createElement(Fixture)));`;
          },
          configureServer(vite) {
            vite.middlewares.use('/catalog-card-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/catalog-card-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/catalog-card-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([360, 768])('keeps the full 44px selection target separate at %i px', async width => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 640 });
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${fixture.origin}catalog-card-test`, { waitUntil: 'domcontentloaded' });
      const checkbox = page.getByRole('checkbox', { name: 'Select Synthetic Card' });
      const deleteButton = page.getByRole('button', { name: 'Delete Synthetic Card' });
      await checkbox.waitFor();
      const geometry = await page.evaluate(() => {
        const target = document.querySelector('label');
        const input = target.querySelector('input');
        const link = document.querySelector('a');
        const del = document.querySelector('button[aria-label="Delete Synthetic Card"]');
        const title = document.querySelector('a span span');
        const box = element => { const r = element.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
        const t = box(target), l = box(link), d = box(del), i = box(input);
        return {target:t,link:l,delete:d,title:box(title),input:i,edgeHit:document.elementFromPoint(t.right-2,t.bottom-2) === target};
      });
      expect(geometry.target.width).toBe(44);
      expect(geometry.target.height).toBe(44);
      expect(geometry.edgeHit).toBe(true);
      expect(geometry.title.left).toBeGreaterThanOrEqual(geometry.target.right);
      expect(geometry.target.right).toBeLessThanOrEqual(geometry.delete.left);
      expect(geometry.input.width).toBe(16);
      expect(geometry.input.height).toBe(16);
      await page.mouse.click(geometry.target.right - 2, geometry.target.bottom - 2);
      expect(await page.getByTestId('selected').textContent()).toBe('true');
      expect(await page.getByTestId('location').textContent()).toBe('/catalog');
      await deleteButton.click();
      expect(await page.getByTestId('location').textContent()).toBe('/catalog');
    } finally {
      await page.close();
    }
  });
});
