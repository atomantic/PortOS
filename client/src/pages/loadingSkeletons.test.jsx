import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

// A hoisted declaration, so the hoisted `vi.mock` factories below can reach it.
// Every exported FUNCTION resolves to a call that never settles, so the page
// stays in its first-paint state for the whole assertion; exported constants
// pass through untouched (a page that reads `PIPELINE_STAGES.includes(...)`
// during render would otherwise crash before it could paint anything).
function pendingModule(path) {
  return async () => {
    const actual = await vi.importActual(path);
    return Object.fromEntries(Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function' ? vi.fn(() => new Promise(() => {})) : value,
    ]));
  };
}

vi.mock('../services/api', pendingModule('../services/api'));
vi.mock('../services/apiCatalog.js', pendingModule('../services/apiCatalog.js'));
vi.mock('../services/apiCreativeDirector.js', pendingModule('../services/apiCreativeDirector.js'));
vi.mock('../services/apiImageVideo.js', pendingModule('../services/apiImageVideo.js'));
vi.mock('../services/apiPipeline.js', pendingModule('../services/apiPipeline.js'));
vi.mock('../services/apiPrompts', pendingModule('../services/apiPrompts'));
vi.mock('../services/apiProviders', pendingModule('../services/apiProviders'));
vi.mock('../services/apiUniverseBuilder.js', pendingModule('../services/apiUniverseBuilder.js'));
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false },
}));

const PAGES_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Structural guard — tree-wide, and the one that catches the actual regression
// this file exists for: a page's top-level `if (loading)` reverting to a bare
// `<div>Loading…</div>`, which exposes no `status` role and reserves no layout,
// so the header/tabs pop in and shove the viewport down (#2843, #5659).
// ---------------------------------------------------------------------------
const LOADING_GUARD = /^ {2}if \((?:loading|isLoading)\b[^)]*\)\s*(\{)?/;

// Reading the source (rather than rendering all ~50 pages) is deliberate: it
// covers every page including ones whose render harness would need a bespoke
// mock, and it keeps working as pages are added.
function loadingGuardBodies(source) {
  const lines = source.split('\n');
  const bodies = [];
  lines.forEach((line, i) => {
    const match = LOADING_GUARD.exec(line);
    if (!match) return;
    if (match[1]) {
      // Braced block: consume until the brace depth returns to zero.
      let depth = 0;
      const block = [];
      for (let j = i; j < lines.length; j += 1) {
        block.push(lines[j]);
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
        if (j > i && depth <= 0) break;
      }
      bodies.push({ line: i + 1, body: block.join('\n') });
      return;
    }
    // Single-expression guard: consume until the statement terminates.
    const block = [lines[i]];
    for (let j = i + 1; !block[block.length - 1].trimEnd().endsWith(';') && j < lines.length; j += 1) {
      block.push(lines[j]);
    }
    bodies.push({ line: i + 1, body: block.join('\n') });
  });
  return bodies;
}

const pageFiles = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith('.jsx') && !f.includes('.test.'))
  .sort();

describe('page loading states reserve their layout', () => {
  it('renders PageSkeleton from every top-level loading guard', () => {
    const offenders = [];
    pageFiles.forEach((file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      loadingGuardBodies(source).forEach(({ line, body }) => {
        // `return null` / bare `return` render nothing at all, so there is no
        // chrome to reflow — they are not skeleton candidates.
        if (/return\s*(null)?\s*;/.test(body) && !body.includes('<')) return;
        if (!body.includes('PageSkeleton')) offenders.push(`${file}:${line}`);
      });
    });
    // A bare `<div>Loading…</div>` exposes no `status` role and reserves no
    // layout, so the header/tabs pop in and shove the viewport down.
    expect(offenders).toEqual([]);
  });

  it('gives every PageSkeleton a label naming what is loading, never the bare default', () => {
    const offenders = [];
    pageFiles.forEach((file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      // One entry per `<PageSkeleton …>` element, self-closing or not.
      const calls = source.match(/<PageSkeleton\b[\s\S]*?\/?>/g) || [];
      calls.forEach((call) => {
        const label = /label="([^"]*)"/.exec(call);
        if (!label || label[1].trim() === '' || label[1] === 'Loading') offenders.push(`${file}: ${call.split('\n')[0]}`);
      });
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Render guard — the pages converted in #5659, each mounted with its fetch
// still in flight. A bare text loader exposes no `status` role, so these fail
// loudly if one comes back.
// ---------------------------------------------------------------------------
const RENDERED = [
  ['AgentsPage', () => import('./AgentsPage').then((m) => m.AgentsPage), '/devtools/agents', '/devtools/agents', 'Scanning for AI agents'],
  ['AIProviders', () => import('./AIProviders'), '/ai', '/ai', 'Loading providers'],
  ['BrainScanReport', () => import('./BrainScanReport'), '/brain/links/:id/scan-report', '/brain/links/l1/scan-report', 'Loading scan report'],
  ['CatalogIngredient', () => import('./CatalogIngredient'), '/catalog/:type/:id', '/catalog/idea/i1', 'Loading ingredient'],
  ['CreativeDirector', () => import('./CreativeDirector'), '/creative-director', '/creative-director', 'Loading Creative Director projects'],
  ['Game', () => import('./Game'), '/game', '/game', 'Loading Game studio'],
  ['Insights (OverviewTab)', () => import('./Insights').then((m) => m.OverviewTab), '/insights/overview', '/insights/overview', 'Loading insights overview'],
  ['Instances', () => import('./Instances'), '/instances', '/instances', 'Loading instances'],
  ['Media3DDetail', () => import('./Media3DDetail'), '/3d/:id', '/3d/abc', 'Loading 3D model'],
  ['PipelineContinuityBible', () => import('./PipelineContinuityBible'), '/pipeline/series/:seriesId/continuity', '/pipeline/series/s1/continuity', 'Loading series continuity'],
  ['PipelineExport', () => import('./PipelineExport'), '/pipeline/series/:seriesId/export', '/pipeline/series/s1/export', 'Loading export options'],
  ['PipelineIssue', () => import('./PipelineIssue'), '/pipeline/issues/:issueId/:stageId', '/pipeline/issues/i1/outline', 'Loading pipeline issue'],
  ['PipelineManuscriptEditor', () => import('./PipelineManuscriptEditor'), '/pipeline/series/:seriesId/manuscript', '/pipeline/series/s1/manuscript', 'Loading manuscript'],
  ['PipelineReverseOutline', () => import('./PipelineReverseOutline'), '/pipeline/series/:seriesId/outline', '/pipeline/series/s1/outline', 'Loading reverse outline'],
  ['PipelineSeries', () => import('./PipelineSeries'), '/pipeline/series/:seriesId', '/pipeline/series/s1', 'Loading series'],
  ['PipelineSeriesRoadmap', () => import('./PipelineSeriesRoadmap'), '/pipeline/series/:seriesId/roadmap', '/pipeline/series/s1/roadmap', 'Loading reader map'],
  ['PipelineVoiceFingerprint', () => import('./PipelineVoiceFingerprint'), '/pipeline/series/:seriesId/voice', '/pipeline/series/s1/voice', 'Loading voice fingerprint'],
  ['PromptManager', () => import('./PromptManager'), '/prompts', '/prompts', 'Loading prompts'],
  ['QuotaBurn', () => import('./QuotaBurn'), '/devtools/quota-burn', '/devtools/quota-burn', 'Loading burn plan'],
  ['RoundEditor', () => import('./RoundEditor'), '/rounds/:id', '/rounds/r1', 'Loading round'],
  ['SongBookViewer', () => import('./SongBookViewer'), '/songbook/:id', '/songbook/s1', 'Loading song'],
  ['Templates', () => import('./Templates'), '/templates', '/templates', 'Loading app templates'],
  ['VideoTimelineEditor', () => import('./VideoTimelineEditor'), '/media/timeline/:projectId', '/media/timeline/p1', 'Loading timeline project'],
  ['WorkspaceContexts', () => import('./WorkspaceContexts'), '/workspace-contexts', '/workspace-contexts', 'Loading workspace projects'],
];

describe('converted pages announce a labelled busy region on first paint', () => {
  beforeEach(() => {
    // jsdom ships no `matchMedia`, and a page that reads one on mount throws
    // before it can paint its skeleton.
    window.matchMedia = vi.fn((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  // A DATA router, not `<MemoryRouter>`: pages that guard unsaved edits call
  // `useBlocker`, which throws outside one.
  it.each(RENDERED)('%s', async (_name, load, routePath, entry, label) => {
    const mod = await load();
    const Page = mod.default || mod;
    const router = createMemoryRouter(
      [{ path: routePath, element: <Page /> }],
      { initialEntries: [entry] },
    );
    render(<RouterProvider router={router} />);
    // Settle the mount effects that fire before the (never-settling) fetch, so
    // the assertion isn't racing an act() warning.
    await act(async () => {});

    const status = screen.getAllByRole('status')[0];
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-label', label);
  });
});
