# Sidebar IA Collapse + Pinned/Recent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the PortOS sidebar from 16 top-level entries to ~11 primary domains plus a collapsed "More" group, add Pinned + Recent working-set sections at the top, fold mis-filed/duplicate domains into their correct parents, and keep Cmd+K + voice navigation working unchanged.

**Architecture:** A pure `navWorkingSet.js` util (localStorage-backed MRU + pin list, no DOM) drives a `useNavWorkingSet` hook that records visits on route change and resolves stored paths to `{ path, label, icon }` for display. `Layout.jsx`'s `navItems` array is rewritten to the new tree and renders Pinned/Recent above it plus a per-row pin toggle. `navManifest.js` entries get re-`section`'d to match the new sidebar groups (paths/ids stay stable, so Cmd+K + voice are unaffected).

**Tech Stack:** React 18 (hooks, react-router-dom `useLocation`), Vitest (jsdom for hooks/components, node for pure utils), lucide-react icons, Tailwind with PortOS design tokens.

**Reference spec:** `docs/superpowers/specs/2026-06-04-sidebar-collapse-ia-design.md`

---

## File Structure

- **Create** `client/src/utils/navWorkingSet.js` — pure MRU + pin list helpers (no React, no DOM). Constants `RECENT_KEY`, `PINNED_KEY`, `RECENT_CAP`; functions `recordVisit`, `togglePin`, `isPinned`.
- **Create** `client/src/utils/navWorkingSet.test.js` — unit tests for the pure helpers (node environment).
- **Create** `client/src/hooks/useNavWorkingSet.js` — reads/writes localStorage, records visits on `location.pathname` change, resolves stored paths to display rows via a path→entry lookup, exposes `{ pinned, recent, pin, unpin, isPinned }`.
- **Create** `client/src/hooks/useNavWorkingSet.test.jsx` — hook tests (jsdom + `@testing-library/react`).
- **Modify** `client/src/hooks/index.js` — add barrel export (catalog maintenance rule).
- **Modify** `client/src/hooks/README.md` — add catalog row.
- **Modify** `client/src/components/Layout.jsx` — rewrite `navItems` tree; render Pinned/Recent sections + per-row pin toggle; add `More` group.
- **Modify** `server/lib/navManifest.js` — re-`section` folded/renamed entries.
- **Modify** `server/lib/navManifest.test.js` — assert every `section` is in the allowed group-label set.

---

## Task 1: Pure navWorkingSet helpers (MRU + pins)

**Files:**
- Create: `client/src/utils/navWorkingSet.js`
- Test: `client/src/utils/navWorkingSet.test.js`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/navWorkingSet.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  RECENT_KEY, PINNED_KEY, RECENT_CAP,
  recordVisit, togglePin, isPinned,
} from './navWorkingSet.js';

describe('navWorkingSet — constants', () => {
  it('exposes stable localStorage keys and a cap of 5', () => {
    expect(RECENT_KEY).toBe('portos-nav-recent');
    expect(PINNED_KEY).toBe('portos-nav-pinned');
    expect(RECENT_CAP).toBe(5);
  });
});

describe('recordVisit', () => {
  it('prepends a new path most-recent-first', () => {
    expect(recordVisit('/b', ['/a'])).toEqual(['/b', '/a']);
  });

  it('dedups — moves an existing path to the front without duplicating', () => {
    expect(recordVisit('/a', ['/b', '/a', '/c'])).toEqual(['/a', '/b', '/c']);
  });

  it('caps the list at RECENT_CAP entries', () => {
    const result = recordVisit('/new', ['/1', '/2', '/3', '/4', '/5']);
    expect(result).toEqual(['/new', '/1', '/2', '/3', '/4']);
    expect(result).toHaveLength(RECENT_CAP);
  });

  it('ignores falsy / non-string paths (returns the list unchanged)', () => {
    expect(recordVisit('', ['/a'])).toEqual(['/a']);
    expect(recordVisit(null, ['/a'])).toEqual(['/a']);
    expect(recordVisit(undefined, ['/a'])).toEqual(['/a']);
    expect(recordVisit(42, ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(recordVisit('/a', null)).toEqual(['/a']);
    expect(recordVisit('/a', undefined)).toEqual(['/a']);
  });
});

describe('togglePin / isPinned', () => {
  it('adds a path when absent', () => {
    expect(togglePin('/a', [])).toEqual(['/a']);
  });

  it('removes a path when present', () => {
    expect(togglePin('/a', ['/a', '/b'])).toEqual(['/b']);
  });

  it('ignores falsy paths', () => {
    expect(togglePin('', ['/a'])).toEqual(['/a']);
    expect(togglePin(null, ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(togglePin('/a', null)).toEqual(['/a']);
  });

  it('isPinned reports membership', () => {
    expect(isPinned('/a', ['/a', '/b'])).toBe(true);
    expect(isPinned('/c', ['/a', '/b'])).toBe(false);
    expect(isPinned('/a', null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/utils/navWorkingSet.test.js`
Expected: FAIL — `Failed to resolve import "./navWorkingSet.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/utils/navWorkingSet.js`:

```js
// Pure working-set helpers for the sidebar Pinned + Recent sections.
// No DOM / localStorage access here — callers (useNavWorkingSet) own I/O so
// this logic is testable in node. Lists are plain string[] of route paths,
// most-recent-first for Recent and insertion-order for Pinned.

export const RECENT_KEY = 'portos-nav-recent';
export const PINNED_KEY = 'portos-nav-pinned';
export const RECENT_CAP = 5;

const asList = (list) => (Array.isArray(list) ? list : []);
const isPath = (p) => typeof p === 'string' && p.length > 0;

// Move/insert `path` to the front of the MRU list, dedup, cap at RECENT_CAP.
export const recordVisit = (path, list) => {
  const current = asList(list);
  if (!isPath(path)) return current;
  return [path, ...current.filter((p) => p !== path)].slice(0, RECENT_CAP);
};

// Add `path` if absent, remove it if present.
export const togglePin = (path, list) => {
  const current = asList(list);
  if (!isPath(path)) return current;
  return current.includes(path)
    ? current.filter((p) => p !== path)
    : [...current, path];
};

export const isPinned = (path, list) => asList(list).includes(path);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/utils/navWorkingSet.test.js`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/navWorkingSet.js client/src/utils/navWorkingSet.test.js
git commit -m "feat([issue-713]): pure nav working-set helpers (MRU + pins)"
```

---

## Task 2: useNavWorkingSet hook

**Files:**
- Create: `client/src/hooks/useNavWorkingSet.js`
- Test: `client/src/hooks/useNavWorkingSet.test.jsx`
- Modify: `client/src/hooks/index.js`
- Modify: `client/src/hooks/README.md`

The hook resolves stored paths to display rows via a `resolveNavEntry(path)` argument so it has no hard dependency on the sidebar's nav array shape (keeps it unit-testable and avoids a circular import with `Layout.jsx`).

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useNavWorkingSet.test.jsx`:

```jsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useNavWorkingSet } from './useNavWorkingSet.js';
import { RECENT_KEY, PINNED_KEY } from '../utils/navWorkingSet.js';

// Minimal resolver: label is the last path segment, icon is a sentinel.
const ICON = () => null;
const resolveNavEntry = (path) => ({ path, label: path.replace('/', '') || 'home', icon: ICON });

function wrapper({ children }) {
  return <MemoryRouter initialEntries={['/start']}>{children}</MemoryRouter>;
}

describe('useNavWorkingSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records the initial route as a recent visit', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    expect(result.current.recent.map((r) => r.path)).toEqual(['/start']);
  });

  it('pin() persists to localStorage and exposes resolved rows', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.pin('/brain/inbox'));
    expect(result.current.isPinned('/brain/inbox')).toBe(true);
    expect(result.current.pinned).toEqual([
      { path: '/brain/inbox', label: 'brain/inbox', icon: ICON },
    ]);
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual(['/brain/inbox']);
  });

  it('unpin() removes a pin', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/a', '/b']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.unpin('/a'));
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/b']);
  });

  it('excludes pinned and the current path from recent', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['/start', '/x', '/y']));
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/x']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    // current path is /start (excluded), /x is pinned (excluded) → only /y
    expect(result.current.recent.map((r) => r.path)).toEqual(['/y']);
  });

  it('drops paths the resolver cannot resolve', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/known']));
    const partialResolver = (path) => (path === '/known' ? { path, label: 'known', icon: ICON } : null);
    const { result } = renderHook(() => useNavWorkingSet(partialResolver), { wrapper });
    act(() => result.current.pin('/unknown'));
    // /unknown is stored but unresolvable → not displayed
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/known']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/hooks/useNavWorkingSet.test.jsx`
Expected: FAIL — `Failed to resolve import "./useNavWorkingSet.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/hooks/useNavWorkingSet.js`:

```js
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  RECENT_KEY, PINNED_KEY,
  recordVisit, togglePin as togglePinPure, isPinned as isPinnedPure,
} from '../utils/navWorkingSet.js';

// Read a JSON string[] from localStorage, tolerating absent/corrupt values.
const readList = (key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
};

const writeList = (key, list) => localStorage.setItem(key, JSON.stringify(list));

/**
 * Sidebar working-set state (Pinned + Recent), persisted to localStorage.
 * @param {(path: string) => ({ path, label, icon } | null)} resolveNavEntry
 *   Maps a stored route path to a display row, or null if it's not a known page.
 */
export function useNavWorkingSet(resolveNavEntry) {
  const location = useLocation();
  const [recentPaths, setRecentPaths] = useState(() => readList(RECENT_KEY));
  const [pinnedPaths, setPinnedPaths] = useState(() => readList(PINNED_KEY));

  // Record a visit whenever the route changes.
  useEffect(() => {
    setRecentPaths((prev) => {
      const next = recordVisit(location.pathname, prev);
      if (next === prev) return prev;
      writeList(RECENT_KEY, next);
      return next;
    });
  }, [location.pathname]);

  const pin = useCallback((path) => {
    setPinnedPaths((prev) => {
      if (isPinnedPure(path, prev)) return prev;
      const next = togglePinPure(path, prev);
      writeList(PINNED_KEY, next);
      return next;
    });
  }, []);

  const unpin = useCallback((path) => {
    setPinnedPaths((prev) => {
      if (!isPinnedPure(path, prev)) return prev;
      const next = togglePinPure(path, prev);
      writeList(PINNED_KEY, next);
      return next;
    });
  }, []);

  const isPinned = useCallback((path) => isPinnedPure(path, pinnedPaths), [pinnedPaths]);

  const resolveAll = useCallback(
    (paths) => paths.map((p) => resolveNavEntry(p)).filter(Boolean),
    [resolveNavEntry],
  );

  const pinned = useMemo(() => resolveAll(pinnedPaths), [resolveAll, pinnedPaths]);

  const recent = useMemo(() => {
    const pinnedSet = new Set(pinnedPaths);
    const visible = recentPaths.filter((p) => p !== location.pathname && !pinnedSet.has(p));
    return resolveAll(visible);
  }, [resolveAll, recentPaths, pinnedPaths, location.pathname]);

  return { pinned, recent, pin, unpin, isPinned };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/hooks/useNavWorkingSet.test.jsx`
Expected: PASS (5 cases green).

- [ ] **Step 5: Add barrel export + catalog row**

In `client/src/hooks/index.js`, under the `// === Storage & persistence ===` group, add after the `useLocalStorageBool.js` line:

```js
export * from './useNavWorkingSet.js';
```

In `client/src/hooks/README.md`, add a row to the catalog table/list (match the existing format of neighboring rows — one line):

```
- `useNavWorkingSet(resolveNavEntry)` — sidebar Pinned + Recent working set (localStorage MRU + pins), resolves stored paths to `{ path, label, icon }` rows.
```

- [ ] **Step 6: Run the hooks barrel/README drift test**

Run: `cd client && npx vitest run src/hooks/index.test.js`
Expected: PASS — the new hook is present in both the barrel and the README, so the drift guard is satisfied.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useNavWorkingSet.js client/src/hooks/useNavWorkingSet.test.jsx client/src/hooks/index.js client/src/hooks/README.md
git commit -m "feat([issue-713]): useNavWorkingSet hook for Pinned + Recent"
```

---

## Task 3: Re-section the nav manifest + section-set guard

This task changes only the `section` field of folded/renamed manifest entries. **Paths, ids, aliases, and keywords stay byte-for-byte unchanged** so Cmd+K and voice keep resolving every page. Then add a test that locks the allowed section set.

**Files:**
- Modify: `server/lib/navManifest.js`
- Modify: `server/lib/navManifest.test.js`

- [ ] **Step 1: Write the failing test**

In `server/lib/navManifest.test.js`, inside the `describe('navManifest — shape invariants', ...)` block, add a new `it`:

```js
  it('every section is one of the approved sidebar group labels', () => {
    const ALLOWED_SECTIONS = new Set([
      'Main', 'Apps', 'Brain', 'Calendar', 'Chief of Staff', 'Create',
      'Dev Tools', 'Goals', 'Health', 'Settings', 'Identity', 'POST',
    ]);
    const bad = NAV_COMMANDS.filter((c) => !ALLOWED_SECTIONS.has(c.section));
    expect(bad.map((c) => `${c.id}:${c.section}`)).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run lib/navManifest.test.js -t "approved sidebar group labels"`
Expected: FAIL — current sections include `Comms`, `Wiki`, `System`, `Digital Twin`, `MeatSpace` which are not in the allowed set, so `bad` is non-empty.

- [ ] **Step 3: Apply the section rewrites**

In `server/lib/navManifest.js`, change ONLY the `section:` value on these entries (leave `id`, `path`, `label`, `aliases`, `keywords` untouched):

- All `nav.messages.*` entries (`nav.messages.inbox`, `nav.messages.drafts`, `nav.messages.config`, `nav.messages.sync`), `nav.openclaw`, `nav.social-agents`: `section: 'Comms'` → `section: 'Brain'`
- All `nav.wiki.*` entries (`overview`, `browse`, `graph`, `log`, `search`): `section: 'Wiki'` → `section: 'Brain'`
- `nav.cos.jobs`: `section: 'System'` → `section: 'Chief of Staff'`
- These System entries → `section: 'Dev Tools'`: `nav.ambient`, `nav.capabilities`, `nav.data`, `nav.instances`, `nav.loops`, `nav.devtools.processes` (already `System` today), `nav.security`, `nav.system-health`, `nav.uploads`
- All `nav.meatspace.*` entries: `section: 'MeatSpace'` → `section: 'Health'`
- All `nav.twin.*` entries, `nav.character`, `nav.ask`: `section: 'Digital Twin'` → `section: 'Identity'`
- `nav.goals`, `nav.goals.tree`: `section: 'Digital Twin'` → `section: 'Goals'`
- `nav.post.*` entries: keep `section: 'POST'` (unchanged — listed for completeness)

Note: `nav.system-health` (`/system-health`) currently sits in section `System`; it moves to `Dev Tools` with the rest of System.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run lib/navManifest.test.js`
Expected: PASS — the new section-set test passes and all existing shape/resolve tests stay green (paths/aliases unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/lib/navManifest.js server/lib/navManifest.test.js
git commit -m "feat([issue-713]): re-section nav manifest for collapsed sidebar groups"
```

---

## Task 4: Rewrite the Layout nav tree (folds + renames + More group)

This task rewrites the `navItems` array in `Layout.jsx` (lines 122–328) to the new structure. No rendering-logic changes — only the data array. Children within each section stay alphabetical per the CLAUDE.md alphabetical-nav rule.

**Files:**
- Modify: `client/src/components/Layout.jsx:122-328`

- [ ] **Step 1: Replace the `navItems` array**

Replace the entire `const navItems = [ ... ];` block (lines 122–328) with the new tree below. Verify every `icon` referenced is already imported at the top of `Layout.jsx` (all icons used here — `Home, ClipboardList, Building2, Package, Brain, Settings, NotebookPen, Calendar, Rss, Network, Upload, MessageSquare, Lightbulb, Link2, Database, FileText, Zap, Shield, CalendarDays, Clock, RefreshCw, Crown, Cpu, Newspaper, Compass, Activity, GraduationCap, Flame, WorkflowIcon, MessagesSquare, FilePen, Inbox, Users, Sparkles, FileInput, Layers, Share2, Wand2, Globe, Terminal, Play, Wrench, Code2, Dog, Github, History, Eraser, Ticket, SquareTerminal, GitBranch, BarChart3, Heart, MessageCircle, PenLine, Swords, Download, Target, Fingerprint, Palette, CheckCircle, Archive, Skull, HeartPulse, Scale, Dna, Cigarette, Lock, Mic, Bot, HardDrive, Camera, BookOpen, Search, MoreHorizontal, ChevronDown, ChevronRight, ExternalLink, LayoutDashboard` — are already imported except possibly `MoreHorizontal`; add `MoreHorizontal` to the lucide-react import if absent). Health uses `Heart` for the section icon.

```js
const navItems = [
  { to: '/', label: 'Dashboard', icon: Home, single: true },
  { to: '/review', label: 'Review Hub', icon: ClipboardList, single: true },
  { to: '/city', label: 'City', icon: Building2, single: true },
  { separator: true },
  { label: 'Apps', icon: Package, dynamic: 'apps', defaultTo: '/apps', children: [] },
  {
    label: 'Brain',
    icon: Brain,
    defaultTo: '/brain/inbox',
    children: [
      { to: '/brain/config', label: 'Config', icon: Settings },
      { to: '/brain/daily-log', label: 'Daily Log', icon: NotebookPen },
      { to: '/brain/digest', label: 'Digest', icon: Calendar },
      { to: '/messages/drafts', label: 'Drafts', icon: FilePen },
      { to: '/brain/feeds', label: 'Feeds', icon: Rss },
      { to: '/brain/graph', label: 'Graph', icon: Network },
      { to: '/brain/import', label: 'Import', icon: Upload },
      { to: '/brain/inbox', label: 'Inbox', icon: MessageSquare },
      { to: '/insights/overview', label: 'Insights', icon: Lightbulb },
      { to: '/brain/links', label: 'Links', icon: Link2 },
      { to: '/brain/memory', label: 'Memory', icon: Database },
      { to: '/messages/inbox', label: 'Messages', icon: Inbox },
      { to: '/messages/config', label: 'Messages Config', icon: Settings },
      { to: '/messages/sync', label: 'Messages Sync', icon: RefreshCw },
      { to: '/brain/notes', label: 'Notes', icon: FileText },
      { to: '/openclaw', label: 'OpenClaw', icon: MessagesSquare },
      { to: '/rapid-reader', label: 'Rapid Reader', icon: Zap },
      { to: '/agents', label: 'Social Agents', icon: Users },
      { to: '/brain/trust', label: 'Trust', icon: Shield },
      { to: '/wiki/overview', label: 'Wiki', icon: BookOpen },
    ],
  },
  {
    label: 'Calendar',
    icon: CalendarDays,
    children: [
      { to: '/calendar/agenda', label: 'Agenda', icon: CalendarDays },
      { to: '/calendar/config', label: 'Config', icon: Settings },
      { to: '/calendar/day', label: 'Day', icon: Calendar },
      { to: '/calendar/lifetime', label: 'Lifetime', icon: Clock },
      { to: '/calendar/month', label: 'Month', icon: CalendarDays },
      { to: '/calendar/review', label: 'Review', icon: ClipboardList },
      { to: '/calendar/sync', label: 'Sync', icon: RefreshCw },
      { to: '/calendar/week', label: 'Week', icon: CalendarDays },
    ],
  },
  {
    label: 'Chief of Staff',
    icon: Crown,
    showBadge: true,
    defaultTo: '/cos/tasks',
    children: [
      { to: '/cos/agents', label: 'Agents', icon: Cpu },
      { to: '/cos/briefing', label: 'Briefing', icon: Newspaper },
      { to: '/cos/config', label: 'Config', icon: Settings },
      { to: '/cos/digest', label: 'Digest', icon: Calendar },
      { to: '/cos/gsd', label: 'GSD', icon: Compass },
      { to: '/cos/health', label: 'Health', icon: Activity },
      { to: '/cos/learning', label: 'Learning', icon: GraduationCap },
      { to: '/cos/memory', label: 'Memory', icon: Brain },
      { to: '/cos/schedule', label: 'Schedule', icon: Clock },
      { to: '/cos/productivity', label: 'Streaks', icon: Flame },
      { to: '/cos/jobs', label: 'System Tasks', icon: Bot },
      { to: '/cos/tasks', label: 'Tasks', icon: FileText },
      { to: '/cos/workflow', label: 'Workflow', icon: WorkflowIcon },
    ],
  },
  {
    label: 'Create',
    icon: Sparkles,
    defaultTo: '/media',
    children: [
      { to: '/catalog', label: 'Catalog', icon: Sparkles },
      { to: '/importer', label: 'Importer', icon: FileInput },
      { to: '/media', label: 'Media Gen', icon: Layers },
      { to: '/pipeline', label: 'Series Pipeline', icon: WorkflowIcon, dynamic: 'pipelineSeries' },
      { to: '/sharing', label: 'Sharing', icon: Share2 },
      { to: '/story-builder', label: 'Story Builder', icon: Wand2 },
      { to: '/universes', label: 'Universes', icon: Globe, dynamic: 'universes' },
      { to: '/writers-room', label: 'Writers Room', icon: NotebookPen },
    ],
  },
  {
    label: 'Dev Tools',
    icon: Terminal,
    children: [
      { to: '/devtools/agents', label: 'AI Agents', icon: Cpu },
      { to: '/devtools/runs', label: 'AI Runs', icon: Play },
      { to: '/ambient', label: 'Ambient', icon: Sparkles },
      { href: '//:5560', label: 'Autofixer', icon: Wrench, external: true, dynamicHost: true },
      { to: '/browser', label: 'Browser', icon: Globe },
      { to: '/capabilities', label: 'Capabilities', icon: Compass },
      { to: '/devtools/runner', label: 'Code', icon: Code2 },
      { to: '/data', label: 'Data', icon: HardDrive },
      { to: '/devtools/datadog', label: 'DataDog', icon: Dog },
      { to: '/feature-agents', label: 'Feature Agents', icon: Wand2 },
      { to: '/devtools/github', label: 'GitHub', icon: Github },
      { to: '/devtools/history', label: 'History', icon: History },
      { to: '/devtools/image-clean', label: 'Image Cleaner', icon: Eraser },
      { to: '/instances', label: 'Instances', icon: Network },
      { to: '/devtools/jira', label: 'JIRA', icon: Ticket },
      { to: '/devtools/jira/reports', label: 'JIRA Reports', icon: FileText },
      { to: '/loops', label: 'Loops', icon: RefreshCw },
      { to: '/devtools/processes', label: 'Processes', icon: Activity },
      { to: '/security', label: 'Security', icon: Camera },
      { to: '/shell', label: 'Shell', icon: SquareTerminal },
      { to: '/devtools/submodules', label: 'Submodules', icon: GitBranch },
      { to: '/system-health', label: 'System Health', icon: Activity },
      { to: '/uploads', label: 'Uploads', icon: Upload },
      { to: '/devtools/usage', label: 'Usage', icon: BarChart3 },
    ],
  },
  { to: '/goals/list', label: 'Goals', icon: Target, single: true },
  {
    label: 'Health',
    icon: Heart,
    defaultTo: '/meatspace/overview',
    children: [
      { to: '/meatspace/age', label: 'Age', icon: Clock },
      { to: '/meatspace/alcohol', label: 'Alcohol', icon: Activity },
      { to: '/meatspace/blood', label: 'Blood', icon: HeartPulse },
      { to: '/meatspace/body', label: 'Body', icon: Scale },
      { to: '/meatspace/health', label: 'Body Health', icon: Heart },
      { to: '/meatspace/export', label: 'Export', icon: FileText },
      { to: '/meatspace/genome', label: 'Genome', icon: Dna },
      { to: '/meatspace/lifestyle', label: 'Lifestyle', icon: ClipboardList },
      { to: '/meatspace/nicotine', label: 'Nicotine', icon: Cigarette },
      { to: '/meatspace/overview', label: 'Overview', icon: Activity },
      { to: '/meatspace/settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    defaultTo: '/settings/general',
    children: [
      { to: '/settings/ai-assignments', label: 'AI Assignments', icon: Bot },
      { to: '/settings/backup', label: 'Backup', icon: Download },
      { to: '/settings/database', label: 'Database', icon: Database },
      { to: '/settings/general', label: 'General', icon: Settings },
      { to: '/settings/local-llm', label: 'Local LLMs', icon: Cpu },
      { to: '/settings/mortalloom', label: 'MortalLoom', icon: Activity },
      { to: '/prompts', label: 'Prompts', icon: FileText },
      { to: '/ai', label: 'Providers', icon: Bot },
      { to: '/settings/security', label: 'Security', icon: Lock },
      { to: '/settings/sharing', label: 'Sharing', icon: Share2 },
      { to: '/settings/telegram', label: 'Telegram', icon: MessageSquare },
      { to: '/settings/voice', label: 'Voice', icon: Mic },
    ],
  },
  { separator: true },
  {
    label: 'Identity',
    icon: Fingerprint,
    defaultTo: '/digital-twin/overview',
    children: [
      { to: '/digital-twin/accounts', label: 'Accounts', icon: Globe },
      { to: '/ask', label: 'Ask Yourself', icon: MessageCircle },
      { to: '/digital-twin/autobiography', label: 'Autobiography', icon: PenLine },
      { to: '/character', label: 'Character', icon: Swords },
      { to: '/digital-twin/documents', label: 'Documents', icon: FileText },
      { to: '/digital-twin/enrich', label: 'Enrich', icon: Sparkles },
      { to: '/digital-twin/export', label: 'Export', icon: Download },
      { to: '/digital-twin/identity', label: 'Identity', icon: Fingerprint },
      { to: '/digital-twin/import', label: 'Import', icon: Upload },
      { to: '/digital-twin/interview', label: 'Interview', icon: MessageSquare },
      { to: '/digital-twin/overview', label: 'Overview', icon: Heart },
      { to: '/digital-twin/taste', label: 'Taste', icon: Palette },
      { to: '/digital-twin/test', label: 'Test', icon: CheckCircle },
      { to: '/digital-twin/time-capsule', label: 'Time Capsule', icon: Archive },
    ],
  },
  {
    label: 'POST',
    icon: Zap,
    defaultTo: '/post/launcher',
    children: [
      { to: '/post/config', label: 'Config', icon: Settings },
      { to: '/post/history', label: 'History', icon: History },
      { to: '/post/launcher', label: 'Launcher', icon: Play },
      { to: '/post/memory', label: 'Memory', icon: Brain },
      { to: '/post/wordplay', label: 'Wordplay', icon: MessageCircle },
    ],
  },
];
```

Notes on this tree:
- `Goals` is now a top-level single (`single: true`), alphabetically between Dev Tools and Health.
- A `{ separator: true }` precedes the `Identity` + `POST` "More" tail. (A visible "More" label group is added in Task 5; for now the separator demarcates the tail and the build stays green.)
- Removed entirely from the rail: the old `Comms`, `Wiki`, `Digital Twin`, `MeatSpace`, `System`, `Catalog`-dup. Their pages now live under Brain / Dev Tools / Health / Identity. `/digital-twin/goals` (Twin Goals) and `nav.twin.appearance`/`personas`/`voice` are reachable via Cmd+K (they were not in the sidebar tree before either — verify none were sidebar-only).

- [ ] **Step 2: Build the client to verify no missing-import / syntax errors**

Run: `cd client && npm run build`
Expected: build succeeds. If it fails with `MoreHorizontal is not defined` or any icon undefined, add the missing icon to the `lucide-react` import at the top of `Layout.jsx` and rebuild.

- [ ] **Step 3: Run the existing client test suite (catch render regressions)**

Run: `cd client && npx vitest run`
Expected: PASS — no test asserts the old nav structure directly; if any snapshot/Layout test breaks, update it to the new tree.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Layout.jsx
git commit -m "feat([issue-713]): collapse sidebar to primary domains + More tail"
```

---

## Task 5: Render Pinned + Recent sections and the per-row pin toggle

Wire `useNavWorkingSet` into `Layout.jsx`, render Pinned/Recent above `navItems`, add a pin toggle on expanded leaf rows, and wrap the Identity/POST tail under a visible "More" label.

**Files:**
- Modify: `client/src/components/Layout.jsx`

- [ ] **Step 1: Import the hook and a Pin icon**

At the top of `Layout.jsx`, add to the existing imports:

```js
import { Pin, PinOff } from 'lucide-react';
import { useNavWorkingSet } from '../hooks/useNavWorkingSet.js';
```

- [ ] **Step 2: Build a path→entry resolver and call the hook**

Inside the `Layout` component, after `resolvedNavItems` is defined (around line 542), add a memoized resolver that flattens all leaf children/singles into a `path → { path, label, icon }` map, then call the hook:

```js
  // Flat path → { path, label, icon } lookup over every leaf nav row, so the
  // Pinned/Recent sections can render a stored path with its real label + icon.
  const navEntryByPath = useMemo(() => {
    const map = new Map();
    const addLeaf = (leaf) => {
      if (leaf?.to && !map.has(leaf.to)) {
        map.set(leaf.to, { path: leaf.to, label: leaf.label, icon: leaf.icon });
      }
    };
    resolvedNavItems.forEach((item) => {
      if (item.single) addLeaf(item);
      (item.children || []).forEach((child) => {
        addLeaf(child);
        (child.grandChildren || []).forEach(addLeaf);
      });
    });
    return map;
  }, [resolvedNavItems]);

  const resolveNavEntry = useCallback(
    (path) => navEntryByPath.get(path) || null,
    [navEntryByPath],
  );

  const { pinned, recent, pin, unpin, isPinned } = useNavWorkingSet(resolveNavEntry);
```

- [ ] **Step 3: Render Pinned + Recent above the nav list**

Find where `resolvedNavItems.map(renderNavItem)` is rendered inside the `<nav>` scroller. Immediately before it, insert a working-set block (hidden when both lists empty, and each sub-section hidden when its own list is empty). Hidden entirely when the sidebar is collapsed (the rail has no room for these rows — they remain reachable via Cmd+K):

```jsx
{!collapsed && (pinned.length > 0 || recent.length > 0) && (
  <div className="mb-2">
    {pinned.length > 0 && (
      <div className="mb-2">
        <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Pinned</div>
        {pinned.map((entry) => (
          <WorkingSetRow key={`pin-${entry.path}`} entry={entry} pinned onTogglePin={() => unpin(entry.path)} onNavigate={() => setMobileOpen(false)} isActive={isActive(entry.path)} />
        ))}
      </div>
    )}
    {recent.length > 0 && (
      <div className="mb-2">
        <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Recent</div>
        {recent.map((entry) => (
          <WorkingSetRow key={`recent-${entry.path}`} entry={entry} pinned={false} onTogglePin={() => pin(entry.path)} onNavigate={() => setMobileOpen(false)} isActive={isActive(entry.path)} />
        ))}
      </div>
    )}
    <div className="mx-4 my-2 border-t border-port-border" />
  </div>
)}
```

- [ ] **Step 4: Add the `WorkingSetRow` component**

At module scope in `Layout.jsx` (above the `Layout` component, near `renderNavItem`'s siblings), add a small presentational component. It renders a `NavLink` plus a pin/unpin button that does NOT navigate (stops propagation):

```jsx
function WorkingSetRow({ entry, pinned, onTogglePin, onNavigate, isActive }) {
  const Icon = entry.icon;
  return (
    <div className="group mx-2 flex items-stretch min-w-0">
      <NavLink
        to={entry.path}
        onClick={onNavigate}
        className={`flex-1 flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors min-w-0 ${
          isActive ? 'bg-port-accent/10 text-port-accent' : 'text-gray-400 hover:text-white hover:bg-port-border/50'
        }`}
      >
        {Icon && <Icon size={16} className="shrink-0" />}
        <span className="min-w-0 truncate">{entry.label}</span>
      </NavLink>
      <button
        type="button"
        aria-label={pinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); }}
        className={`px-2 rounded-lg hover:bg-port-border/50 ${pinned ? 'text-port-accent' : 'text-gray-500 opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Add a pin toggle to expanded leaf nav rows**

In `renderNavItem`'s child-rendering block (the `NavLink` for `child.to` starting around line 775), wrap the existing child `NavLink` in a `group` flex container and append a pin button mirroring `WorkingSetRow`'s button. The child container `<div key={child.to} className="min-w-0">` becomes:

```jsx
<div key={child.to} className="group min-w-0 flex items-stretch">
```

and immediately after the closing `</NavLink>` of the child link (but before the grandChildren block), add:

```jsx
{!collapsed && (
  <button
    type="button"
    aria-label={isPinned(child.to) ? `Unpin ${child.label}` : `Pin ${child.label}`}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); isPinned(child.to) ? unpin(child.to) : pin(child.to); }}
    className={`px-2 rounded-lg hover:bg-port-border/50 ${isPinned(child.to) ? 'text-port-accent' : 'text-gray-500 opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
  >
    {isPinned(child.to) ? <PinOff size={14} /> : <Pin size={14} />}
  </button>
)}
```

Note: the grandChildren block currently lives inside `<div key={child.to}>`. Since we changed that div to a flex row, move the grandChildren rendering OUT into a sibling wrapper so the pin button doesn't sit beside the grandchild list. Restructure to:

```jsx
<div key={child.to} className="min-w-0">
  <div className="group min-w-0 flex items-stretch">
    {/* existing child NavLink here */}
    {/* pin button here */}
  </div>
  {grandChildren.length > 0 && (
    {/* existing grandChildren block unchanged */}
  )}
</div>
```

- [ ] **Step 6: Wrap the Identity/POST tail under a visible "More" group label**

Replace the bare `{ separator: true }` before `Identity` (added in Task 4) with a non-interactive "More" label. The simplest approach that reuses `renderNavItem`: change the separator entry to `{ moreLabel: true }` and handle it at the top of `renderNavItem`:

```jsx
if (item.moreLabel) {
  return (
    <div key="more-label" className="mx-4 mt-3 mb-1 pt-2 border-t border-port-border text-[10px] font-semibold uppercase tracking-wide text-gray-500">
      More
    </div>
  );
}
```

And in the `navItems` array (Task 4), change the `{ separator: true }` that precedes `Identity` to `{ moreLabel: true }`.

- [ ] **Step 7: Build and run the client suite**

Run: `cd client && npm run build && npx vitest run`
Expected: build succeeds, tests pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/Layout.jsx
git commit -m "feat([issue-713]): render Pinned + Recent sections and pin toggles"
```

---

## Task 6: Manual verification + changelog

**Files:**
- Modify: `.changelog/NEXT.md`

- [ ] **Step 1: Start the dev server and verify behavior**

Run: `cd /Users/antic/github.com/atomantic/PortOS/data/cos/worktrees/claim-issue-713 && npm run dev` (or `npm start`).

Manually verify in the browser:
1. Sidebar shows ~11 primary entries + a "More" group (Identity, POST). No Comms/Wiki/System/MeatSpace/Digital Twin top-level groups.
2. Brain expands to include Messages, OpenClaw, Social Agents, Wiki (single link → Wiki page with its own tab bar).
3. Dev Tools expands to include Data, Instances, Loops, Processes, Security, Capabilities, Uploads, Ambient, System Health.
4. Chief of Staff includes System Tasks.
5. Health (renamed from MeatSpace) shows the meatspace pages.
6. Navigate a few pages → Recent populates (max 5, current excluded). Hover a leaf row → pin icon appears; click it → page moves to Pinned and out of Recent. Unpin → returns to Recent flow.
7. `⌘K` → search "wiki", "messages", "processes", "meatspace health" → all still resolve and navigate.
8. Collapse the sidebar → flyouts still list folded children; Pinned/Recent hidden (expected).

- [ ] **Step 2: Add a changelog entry**

Append to `.changelog/NEXT.md` under the appropriate heading (read `.changelog/README.md` style rules first — user-facing, no file paths):

```markdown
- **[issue-713] Simpler sidebar with Pinned & Recent** — The left navigation is collapsed to a focused set of top-level areas with a "More" group for the long tail, and now surfaces the pages you pin and the ones you visited most recently right at the top. Deep pages moved into their natural home (messaging and your wiki live under Brain, system tools under Dev Tools, health tracking is now just "Health"), and everything stays reachable from ⌘K and voice.
```

- [ ] **Step 3: Commit**

```bash
git add .changelog/NEXT.md
git commit -m "docs([issue-713]): changelog for sidebar IA collapse"
```

---

## Self-Review Notes (for the implementer)

- **Cmd+K parity is the highest-risk area.** Task 3 changes only `section` fields, never paths/aliases — so `resolveNavCommand` behavior is unchanged. If you ever feel tempted to change a path or alias, stop: that breaks voice nav and the palette tab-coverage test.
- **The `isFullWidth` scroll list in `Layout.jsx` (~line 1044) is keyed on raw pathnames** and is independent of nav grouping. Do NOT touch it — folding domains doesn't change any route.
- **Alphabetical ordering** within each section is required (CLAUDE.md). The Task 4 tree is already alphabetized by `label` within each group; preserve that if you adjust anything.
- **Pages that were sidebar-reachable before must stay reachable** (sidebar or Cmd+K). The old tree's `/digital-twin/goals` "Twin Goals" was a manifest-only entry (`nav.twin.goals`), still reachable via ⌘K. Confirm no page that was ONLY in the sidebar got dropped — every `to:` removed from the old tree maps to a child in the new tree or a manifest entry.
