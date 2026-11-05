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

describe.skipIf(!chrome)('Catalog consolidation responsive review', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'catalog-consolidation-review', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/catalog/CatalogMergePanel.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'catalog-consolidation-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/catalog-consolidation-fixture.jsx') return '\0catalog-consolidation-fixture.jsx';
            if (/\/services\/apiCatalog(?:\.jsx?)?$/.test(id)) return '\0catalog-consolidation-api';
            if (/\/services\/apiSystem(?:\.jsx?)?$/.test(id)) return '\0catalog-consolidation-system';
            if (/\/ui\/Toast(?:\.jsx?)?$/.test(id)) return '\0catalog-consolidation-toast';
          },
          load(id) {
            if (id === '\0catalog-consolidation-system') return 'export const getSelfInstance = async () => ({instanceId:"fixture-local"});';
            if (id === '\0catalog-consolidation-toast') return 'export default {success(){}};';
            if (id === '\0catalog-consolidation-api') return `
              const source = {id:'fixture-source',name:'Synthetic source',type:'object',originInstanceId:'fixture-local',payload:{locked:false,description:'A different description'}};
              export const getCatalogIngredientDetails = async () => ({ingredient:source});
              export const listCatalogIngredients = async () => ({items:[source]});
              export const listCatalogMergeHistory = async () => ({items:[],nextOffset:null});
              export const previewCatalogMerge = async ({fieldChoices}) => {
                const conflicts = [
                  {path:'/name',source:'Synthetic source',survivor:'Synthetic survivor'},
                  {path:'/payload/description',source:'Source description with '+ 'LongUnbrokenValue'.repeat(25),survivor:'Survivor description with '+ 'LongUnbrokenValue'.repeat(25)}
                ];
                window.previewCalls = (window.previewCalls || 0) + 1;
                return {previewToken:'synthetic-token',proposed:source,counts:{media:2},conflicts:conflicts.filter(item=>!fieldChoices[item.path])};
              };
              export const applyCatalogMerge = async () => { throw new Error('Fixture must never apply'); };
              export const getCatalogMergeReceipt = async () => ({});
              export const recoverCatalogMerge = async () => { throw new Error('Fixture must never recover'); };
              export const refineCatalogDraft = async () => ({});
            `;
            if (id !== '\0catalog-consolidation-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import CatalogMergePanel from '/src/components/catalog/CatalogMergePanel.jsx';
              import { CatalogRedesignButton } from '/src/components/catalog/CatalogRedesign.jsx';
              import '/src/index.css';
              const record={id:'fixture-survivor',name:'Synthetic survivor',type:'object',originInstanceId:'fixture-local',payload:{locked:false,description:'Synthetic description'}};
              function Fixture(){
                const [open,setOpen]=React.useState(false);
                return React.createElement('main', {style:{width:'100%',maxWidth:520,margin:'0 auto',padding:12,boxSizing:'border-box'},'data-testid':'container'},
                  React.createElement('header',{className:'flex items-center gap-2 flex-wrap justify-end mb-4'},
                    React.createElement(CatalogRedesignButton,{type:'object',open,onToggle:()=>setOpen(!open),controls:'fixture-redesign'}),
                    ...['Lock','Save','Thread','Delete'].map(label=>React.createElement('button',{key:label,className:'min-h-11 border px-3 py-2 rounded'},label))),
                  React.createElement('div',{id:'fixture-redesign',hidden:!open},'Synthetic creative conversation'),
                  React.createElement(CatalogMergePanel,{record}));
              }
              createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/objects/fixture-survivor/profile?mergeSource=fixture-source']},React.createElement(Fixture)));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/catalog-consolidation-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/catalog-consolidation-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/catalog-consolidation-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([360, 768, 1280])('fits long conflict values and refreshes beside confirmation at %i px', async width => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 640 });
    page.setDefaultTimeout(10000);
    try {
      await page.goto(`${fixture.origin}catalog-consolidation-test`, { waitUntil: 'domcontentloaded' });
      const redesign = page.getByRole('button', { name: 'Redesign with a creative assistant' });
      await redesign.click();
      expect(await page.getByText('Synthetic creative conversation').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Close redesign conversation' }).click();
      await page.getByRole('button', { name: 'Preview consolidation' }).click();
      await page.getByText('2 field choices remaining.', { exact: false }).waitFor();
      const overflow = await page.getByTestId('container').evaluate(container => {
        const boundary = container.getBoundingClientRect();
        return [...container.querySelectorAll('*')].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.left < boundary.left - 1 || box.right > boundary.right + 1);
        }).map(element => ({tag:element.tagName,text:element.textContent.slice(0,100),width:element.getBoundingClientRect().width}));
      });
      expect(overflow).toEqual([]);
      expect(await redesign.boundingBox()).toMatchObject({ height: 44 });
      const radios = page.getByRole('radio', { name: /Keep survivor value/ });
      await radios.nth(0).check();
      expect(await page.evaluate(() => window.previewCalls)).toBe(1);
      await radios.nth(1).check();
      await page.getByText('Preview is up to date.', { exact: false }).waitFor();
      expect(await page.evaluate(() => window.previewCalls)).toBe(2);
      expect(await page.getByRole('button', { name: 'Consolidate locally' }).isDisabled()).toBe(true);
      await page.getByRole('checkbox', { name: /I confirm these/ }).check();
      expect(await page.getByRole('button', { name: 'Consolidate locally' }).isEnabled()).toBe(true);
      await page.getByRole('radio', { name: /Use source value/ }).nth(0).check();
      await page.getByText('Preview is up to date.', { exact: false }).waitFor();
      expect(await page.getByRole('checkbox', { name: /I confirm these/ }).isChecked()).toBe(false);
      expect(await page.getByRole('button', { name: 'Consolidate locally' }).isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
