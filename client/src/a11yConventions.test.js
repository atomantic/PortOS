/**
 * Repo-wide accessibility conventions.
 *
 * These encode the regressions that keep reappearing across a11y audit passes,
 * so a new component fails the suite instead of shipping the gap:
 *
 *   1. A hand-rolled `fixed inset-0 … bg-black/N` overlay instead of the shared
 *      `ui/Modal`, which owns the focus trap, the Esc stack, `role="dialog"`,
 *      and focus restore. A hand-rolled backdrop is click-to-dismiss only — a
 *      keyboard user has no way out and tabs straight through to the page
 *      behind it.
 *   2. A toggle-switch-shaped `<button>` (a pill track with a sliding knob)
 *      that never says it is a switch, so assistive tech announces "button"
 *      with no on/off state. `components/ToggleSwitch.jsx` is the shared
 *      widget; hand-rolled tracks must at least carry `role="switch"` +
 *      `aria-checked`.
 *   3. A `<input type="file">` hidden with `hidden`/`aria-hidden`/`tabIndex={-1}`
 *      and driven by a programmatic `ref.current.click()`. That is unreachable
 *      by keyboard and screen reader, and the synthetic click doesn't open the
 *      picker at all in WebKit-as-installed-PWA — the shape PortOS is opened in
 *      from a second machine over the tailnet. `components/ui/FilePickerButton.jsx`
 *      is the shared widget (sr-only input + native `<label for>` activation).
 *   4. A `duration: Infinity` toast whose content is JSX or a render prop but
 *      which passes no `label`. Such a toast collapses to a pill after
 *      COLLAPSE_AFTER_MS (so it stops covering the page), and the pill has no
 *      text of its own to name itself with.
 *
 * Scoped to git-tracked `.jsx` under `client/src` so an untracked scratch file
 * can't fail the suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedJsxFiles as trackedJsx, trackedSourceFiles as trackedSources } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Shared with the other repo-hygiene guards (see `src/test/trackedFiles.js` for
// why `.js` is included alongside `.jsx`: the OpenClaw composer's file-input ref
// lived in `hooks/useOpenClawAttachments.js`, exactly the hole a `.jsx`-only
// scan leaves open).
const trackedJsxFiles = () => trackedJsx(CLIENT_ROOT);
const trackedSourceFiles = () => trackedSources(CLIENT_ROOT);

/**
 * Slice out the full opening tag starting at `index`, tolerating `>` inside
 * JSX expression containers (`className={`a > b`}`) by tracking brace depth.
 */
function openingTagAt(src, index, nameLength) {
  let depth = 0;
  for (let i = index + nameLength; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(index, i + 1);
  }
  return null;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Slice a call's full argument list, `(` through its matching `)`, starting at
 * the opening paren. Skips over string and template literals so a `)` inside
 * one can't close the call early.
 */
function balancedCallAt(src, openIndex, skipStrings = true) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (skipStrings && (c === '\'' || c === '"' || c === '`')) {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(openIndex, i + 1);
  }
  // Falling off the end means a quote opened a "string" that never closed —
  // in practice an apostrophe in JSX text, `toast(<p>You're out of sync</p>,
  // { duration: Infinity })`. The scan swallows the closing paren, the caller
  // skips the unparseable call, and the toast rule silently misses the one
  // shape it exists to catch: JSX content, which is precisely what needs
  // `label`. Retry counting parens only — a `)` inside a real string could
  // close early, but a well-formed string already returned on the first pass.
  return skipStrings ? balancedCallAt(src, openIndex, false) : null;
}

// --- helpers for the icon-only-button-name and 44px-close-target rules ---

// Find the index of the `}` matching the `{` at `s[idx]`, respecting nested
// braces and quoted/template strings.
function matchingBraceEnd(s, idx) {
  let depth = 0;
  for (let i = idx; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '\'' || c === '`') {
      const q = c;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Find the top-level `>` closing a JSX opening tag starting at `s[idx]` (`<`),
// respecting `{...}` attribute-expression nesting and quoted strings inside
// them. Returns `{ end, selfClosing }`, `end` being the index just past `>`.
function tagBoundaryAt(s, idx) {
  let depth = 0;
  for (let i = idx + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if ((c === '"' || c === '\'' || c === '`') && depth > 0) {
      const q = c;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
    } else if (c === '>' && depth === 0) {
      let back = i - 1;
      while (back > idx && /\s/.test(s[back])) back--;
      return { end: i + 1, selfClosing: s[back] === '/' };
    }
  }
  return null;
}

const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

// A button body counts as icon-only when it is a SOLE top-level JSX child: a
// single self-closing capitalized component, or a `{...}` expression whose
// entire content is a ternary/`&&` between two such components (the
// play/pause, expand/collapse shape). A naive `^<Icon.../>$`-shaped regex
// over the raw body text is unsafe here — a wildcard greedily matches straight
// across sibling boundaries, so `<Icon/><span>text</span>` misreads as one
// self-closing element with a visible-text sibling silently absorbed into it.
// Walking to the true boundary of the first top-level node and checking
// nothing follows it is what catches that case (see ui/ProvenanceChip.jsx,
// whose icon + <span>label</span> + icon button must NOT be flagged, since
// the <span> already gives it an accessible name).
function soleTopLevelNode(rawBody) {
  const s = stripJsxComments(rawBody).trim();
  if (!s) return null;
  if (s[0] === '<') {
    const boundary = tagBoundaryAt(s, 0);
    if (!boundary) return null;
    if (s.slice(boundary.end).trim() !== '') return null; // more than one top-level node
    return { kind: 'element', raw: s.slice(0, boundary.end), selfClosing: boundary.selfClosing };
  }
  if (s[0] === '{') {
    const end = matchingBraceEnd(s, 0);
    if (end === -1) return null;
    if (s.slice(end + 1).trim() !== '') return null; // more than one top-level node
    return { kind: 'expr', inner: s.slice(1, end).trim() };
  }
  return null; // bare text at top level
}

function matchTernaryIcons(inner) {
  let depth = 0;
  let qIdx = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '?' && depth === 0 && inner[i + 1] !== '.') { qIdx = i; break; }
  }
  if (qIdx === -1) return false;
  depth = 0;
  let cIdx = -1;
  for (let i = qIdx + 1; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) { cIdx = i; break; }
  }
  if (cIdx === -1) return false;
  const a = inner.slice(qIdx + 1, cIdx).trim();
  const b = inner.slice(cIdx + 1).trim();
  const iconRe = /^<[A-Z][\w.]*(\s[\s\S]*)?\/>$/;
  return iconRe.test(a) && iconRe.test(b);
}

// Unwrap presentational wrappers: a button whose body is `<span><X/></span>`
// (an extra element for padding, a hover background, or a badge) is still
// icon-only, but a walker that stops at the wrapper's opening tag reads its
// children as "more than one top-level node" and skips the button entirely.
// Recurse through lowercase host elements that carry no text of their own.
function unwrapPresentational(rawBody, depth = 0) {
  if (depth > 4) return rawBody;
  const s = stripJsxComments(rawBody).trim();
  const m = s.match(/^<([a-z][\w-]*)\b/);
  if (!m) return s;
  const boundary = tagBoundaryAt(s, 0);
  if (!boundary || boundary.selfClosing) return s;
  const close = `</${m[1]}>`;
  if (!s.endsWith(close)) return s;
  return unwrapPresentational(s.slice(boundary.end, s.length - close.length), depth + 1);
}

function isIconOnlyBody(rawBodyIn) {
  const rawBody = unwrapPresentational(rawBodyIn);
  const node = soleTopLevelNode(rawBody);
  if (!node) return false;
  if (node.kind === 'element') return node.selfClosing && /^<[A-Z]/.test(node.raw);
  const inner = node.inner;
  if (matchTernaryIcons(inner)) return true;
  const andMatch = inner.match(/^.*&&\s*(<[A-Z][\w.]*(\s[\s\S]*)?\/>)\s*$/s);
  if (!andMatch) return false;
  return /^<[A-Z][\w.]*(\s[\s\S]*)?\/>$/.test(andMatch[1].trim());
}

// Buttons don't nest in valid HTML/JSX, so the first `</button>` after the
// opening tag's end is its match.
function findButtonBody(src, openEnd) {
  const closeIdx = src.indexOf('</button>', openEnd);
  return closeIdx === -1 ? null : src.slice(openEnd, closeIdx);
}

// Tailwind `h-`/`w-`/`min-h-`/`min-w-` token → px, for both an arbitrary
// value (`min-h-[44px]`) and the spacing scale (`h-11` = 11 * 4px = 44px).
function tokenPx(token) {
  const arb = token.match(/^(?:min-)?[hw]-\[(\d+(?:\.\d+)?)px\]$/);
  if (arb) return parseFloat(arb[1]);
  const scale = token.match(/^(?:min-)?[hw]-(\d+(?:\.5)?)$/);
  if (scale) return parseFloat(scale[1]) * 4;
  return null;
}

function hasFortyFourMinTouchTarget(cls) {
  let hOk = false;
  let wOk = false;
  for (const token of cls.split(/\s+/)) {
    if (/^(?:min-)?h-/.test(token) && tokenPx(token) >= 44) hOk = true;
    if (/^(?:min-)?w-/.test(token) && tokenPx(token) >= 44) wOk = true;
  }
  return hOk && wOk;
}

// Return a static JSX attribute value, including the common expression forms
// used for paired input ids (`id={fieldId}` / `id={`field-${id}`}`). Dynamic
// expressions are compared as source text, which is sufficient for matching
// an input and its label when they share the same expression in one file.
function attributeValue(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=`).exec(tag);
  if (!match) return null;

  let index = match.index + match[0].length;
  while (/\s/.test(tag[index])) index++;

  if (tag[index] === '"' || tag[index] === "'" || tag[index] === '`') {
    const quote = tag[index];
    for (let end = index + 1; end < tag.length; end++) {
      if (tag[end] === '\\') { end++; continue; }
      if (tag[end] === quote) return tag.slice(index + 1, end);
    }
    return null;
  }

  if (tag[index] === '{') {
    const end = matchingBraceEnd(tag, index);
    if (end === -1) return null;
    return tag.slice(index + 1, end).trim();
  }

  const rest = tag.slice(index);
  const end = rest.search(/[\s/>]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

function normalizedAttributeValue(value) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ['"', "'", '`'].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Keep source indexes stable while removing comments that may contain JSX
// examples. This lets the repo-wide scan inspect actual elements without
// reporting documentation snippets such as `<input>` in a component header.
function maskComments(src) {
  const chars = [...src];
  let quote = null;
  for (let i = 0; i < chars.length; i++) {
    if (quote) {
      if (chars[i] === '\\') { i++; continue; }
      if (chars[i] === quote) quote = null;
      continue;
    }
    if (chars[i] === '"' || chars[i] === "'" || chars[i] === '`') {
      quote = chars[i];
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '/') {
      for (i += 1; i < chars.length && chars[i] !== '\n'; i++) chars[i] = ' ';
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      for (i += 2; i < chars.length - 1; i++) {
        if (chars[i] === '*' && chars[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i++;
          break;
        }
        if (chars[i] !== '\n') chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}

function hasMatchingExplicitLabel(src, id) {
  const re = /<label\b/g;
  let match;
  while ((match = re.exec(src))) {
    const tag = openingTagAt(src, match.index, '<label'.length);
    if (!tag) continue;
    const htmlFor = normalizedAttributeValue(attributeValue(tag, 'htmlFor'));
    if (htmlFor === id) return true;
  }
  return false;
}

function isNestedInLabel(src, index) {
  let depth = 0;
  const re = /<\/?label\b/g;
  let match;
  while ((match = re.exec(src)) && match.index < index) {
    if (match[0].startsWith('</')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const tag = openingTagAt(src, match.index, '<label'.length);
    if (!tag) continue;
    if (!/\/\s*>$/.test(tag)) depth++;
    re.lastIndex = match.index + tag.length;
  }
  return depth > 0;
}

function isNestedInLabeledFormField(src, index) {
  const stack = [];
  const re = /<\/?FormField\b/g;
  let match;
  while ((match = re.exec(src)) && match.index < index) {
    if (match[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const tag = openingTagAt(src, match.index, '<FormField'.length);
    if (!tag) continue;
    if (!/\/\s*>$/.test(tag)) stack.push(attributeValue(tag, 'label') !== null);
    re.lastIndex = match.index + tag.length;
  }
  return stack.some(Boolean);
}

function hasAccessibleInputName(src, tag, index) {
  if (/\baria-label(?:ledby)?\s*=/.test(tag)) return true;
  if (normalizedAttributeValue(attributeValue(tag, 'type'))?.toLowerCase() === 'hidden') return true;
  if (isNestedInLabel(src, index) || isNestedInLabeledFormField(src, index)) return true;

  const id = normalizedAttributeValue(attributeValue(tag, 'id'));
  return id !== null && id !== '' && hasMatchingExplicitLabel(src, id);
}

// These are pre-existing controls exposed when the rule was generalized. The
// migration is tracked in #4297. Keep exceptions location-specific so a new
// input in an existing file still fails the guard; remove each entry as its
// control receives a real name.
const PREEXISTING_INPUT_NAME_ALLOWLIST = new Set([
  'src/components/CronInput.jsx:65',
  'src/components/EntityCombobox.jsx:125',
  'src/components/TagPicker.jsx:103',
  'src/components/agents/tabs/ToolsTab.jsx:581',
  'src/components/agents/tabs/WorldTab.jsx:406',
  'src/components/agents/tabs/WorldTab.jsx:407',
  'src/components/agents/tabs/WorldTab.jsx:408',
  'src/components/agents/tabs/WorldTab.jsx:413',
  'src/components/agents/tabs/WorldTab.jsx:418',
  'src/components/agents/tabs/WorldTab.jsx:419',
  'src/components/agents/tabs/WorldTab.jsx:420',
  'src/components/agents/tabs/WorldTab.jsx:437',
  'src/components/agents/tabs/WorldTab.jsx:438',
  'src/components/agents/tabs/WorldTab.jsx:831',
  'src/components/agents/tabs/WorldTab.jsx:862',
  'src/components/agents/tabs/WorldTab.jsx:955',
  'src/components/agents/tabs/WorldTab.jsx:963',
  'src/components/apps/ReferenceReposPanel.jsx:399',
  'src/components/apps/ReferenceReposPanel.jsx:406',
  'src/components/apps/ReferenceReposPanel.jsx:413',
  'src/components/apps/tabs/CustomTasksSection.jsx:115',
  'src/components/apps/tabs/CustomTasksSection.jsx:122',
  'src/components/apps/tabs/CustomTasksSection.jsx:157',
  'src/components/apps/tabs/CustomTasksSection.jsx:186',
  'src/components/apps/tabs/GitTab.jsx:517',
  'src/components/brain/tabs/DailyLogTab.jsx:929',
  'src/components/brain/tabs/FeedsTab.jsx:143',
  'src/components/brain/tabs/InboxTab.jsx:320',
  'src/components/brain/tabs/LinksTab.jsx:367',
  'src/components/brain/tabs/LinksTab.jsx:466',
  'src/components/brain/tabs/LinksTab.jsx:548',
  'src/components/brain/tabs/MemoryTab.jsx:318',
  'src/components/brain/tabs/MemoryTab.jsx:332',
  'src/components/brain/tabs/MemoryTab.jsx:345',
  'src/components/brain/tabs/MemoryTab.jsx:363',
  'src/components/brain/tabs/MemoryTab.jsx:383',
  'src/components/brain/tabs/MemoryTab.jsx:398',
  'src/components/brain/tabs/MemoryTab.jsx:418',
  'src/components/brain/tabs/MemoryTab.jsx:434',
  'src/components/brain/tabs/MemoryTab.jsx:441',
  'src/components/brain/tabs/MemoryTab.jsx:454',
  'src/components/brain/tabs/MemoryTab.jsx:468',
  'src/components/brain/tabs/MemoryTab.jsx:475',
  'src/components/brain/tabs/MemoryTab.jsx:770',
  'src/components/brain/tabs/NotesTab.jsx:305',
  'src/components/brain/tabs/NotesTab.jsx:327',
  'src/components/brain/tabs/NotesTab.jsx:745',
  'src/components/calendar/AgendaTab.jsx:90',
  'src/components/calendar/ConfigTab.jsx:472',
  'src/components/calendar/ConfigTab.jsx:479',
  'src/components/calendar/ReviewTab.jsx:116',
  'src/components/calendar/ReviewTab.jsx:289',
  'src/components/calendar/ReviewTab.jsx:300',
  'src/components/cos/TaskAddForm.jsx:788',
  'src/components/cos/tabs/AgentCard.jsx:734',
  'src/components/cos/tabs/AgentCard.jsx:896',
  'src/components/cos/tabs/ConfigRow.jsx:16',
  'src/components/cos/tabs/ConfigRow.jsx:8',
  'src/components/cos/tabs/JobsTab.jsx:225',
  'src/components/cos/tabs/JobsTab.jsx:260',
  'src/components/cos/tabs/JobsTab.jsx:458',
  'src/components/cos/tabs/JobsTab.jsx:465',
  'src/components/cos/tabs/JobsTab.jsx:802',
  'src/components/cos/tabs/JobsTab.jsx:818',
  'src/components/cos/tabs/JobsTab.jsx:826',
  'src/components/cos/tabs/MemoryEditModal.jsx:228',
  'src/components/cos/tabs/TaskItem.jsx:354',
  'src/components/cos/tabs/TaskItem.jsx:639',
  'src/components/cos/tabs/workflow/ScheduleEditor.jsx:208',
  'src/components/dashboard/LayoutEditor.jsx:304',
  'src/components/dashboard/LayoutEditor.jsx:364',
  'src/components/digital-twin/tabs/DocumentsTab.jsx:208',
  'src/components/digital-twin/tabs/DocumentsTab.jsx:272',
  'src/components/digital-twin/tabs/GoalsTab.jsx:165',
  'src/components/digital-twin/tabs/GoalsTab.jsx:273',
  'src/components/digital-twin/tabs/GoalsTab.jsx:438',
  'src/components/digital-twin/tabs/GoalsTab.jsx:446',
  'src/components/digital-twin/tabs/TimeCapsuleTab.jsx:158',
  'src/components/digital-twin/tabs/TimeCapsuleTab.jsx:293',
  'src/components/goals/GoalEditForm.jsx:139',
  'src/components/goals/GoalEditForm.jsx:174',
  'src/components/goals/GoalEditForm.jsx:38',
  'src/components/goals/GoalLinkedCalendars.jsx:58',
  'src/components/goals/GoalMilestones.jsx:79',
  'src/components/goals/GoalPlanSection.jsx:185',
  'src/components/goals/GoalPlanSection.jsx:195',
  'src/components/goals/GoalPlanSection.jsx:74',
  'src/components/goals/GoalPlanSection.jsx:84',
  'src/components/goals/GoalPlanSection.jsx:97',
  'src/components/goals/GoalProgressLog.jsx:35',
  'src/components/goals/GoalProgressLog.jsx:50',
  'src/components/goals/GoalTodoList.jsx:71',
  'src/components/goals/GoalTodoList.jsx:98',
  'src/components/goals/GoalsListView.jsx:339',
  'src/components/goals/GoalsListView.jsx:349',
  'src/components/goals/GoalsListView.jsx:417',
  'src/components/goals/GoalsTreeView.jsx:484',
  'src/components/goals/GoalsTreeView.jsx:562',
  'src/components/imageGen/HfTokenBanner.jsx:102',
  'src/components/imageGen/LoraPicker.jsx:127',
  'src/components/insights/GoalScorecardTab.jsx:98',
  'src/components/loraTraining/ImportGalleryDialog.jsx:90',
  'src/components/meatspace/EpigeneticTracker.jsx:149',
  'src/components/meatspace/EpigeneticTracker.jsx:174',
  'src/components/meatspace/EpigeneticTracker.jsx:181',
  'src/components/meatspace/EpigeneticTracker.jsx:265',
  'src/components/meatspace/post/ElementsSong.jsx:1001',
  'src/components/meatspace/post/ElementsSong.jsx:1152',
  'src/components/meatspace/post/ElementsSong.jsx:345',
  'src/components/meatspace/post/MemoryPractice.jsx:646',
  'src/components/meatspace/post/MorseTrainer.jsx:1136',
  'src/components/meatspace/post/MorseTrainer.jsx:651',
  'src/components/meatspace/post/PostCognitiveDrillRunner.jsx:647',
  'src/components/meatspace/post/PostDrillRunner.jsx:211',
  'src/components/meatspace/post/PostLlmDrillRunner.jsx:630',
  'src/components/meatspace/post/PostLlmDrillRunner.jsx:672',
  'src/components/meatspace/post/PostLlmDrillRunner.jsx:800',
  'src/components/meatspace/post/WordplayDrillUI.jsx:127',
  'src/components/meatspace/post/WordplayDrillUI.jsx:182',
  'src/components/meatspace/tabs/AgeTab.jsx:47',
  'src/components/meatspace/tabs/AlcoholTab.jsx:350',
  'src/components/meatspace/tabs/AlcoholTab.jsx:357',
  'src/components/meatspace/tabs/AlcoholTab.jsx:373',
  'src/components/meatspace/tabs/AlcoholTab.jsx:418',
  'src/components/meatspace/tabs/AlcoholTab.jsx:425',
  'src/components/meatspace/tabs/AlcoholTab.jsx:441',
  'src/components/meatspace/tabs/AlcoholTab.jsx:486',
  'src/components/meatspace/tabs/AlcoholTab.jsx:574',
  'src/components/meatspace/tabs/AlcoholTab.jsx:597',
  'src/components/meatspace/tabs/AlcoholTab.jsx:606',
  'src/components/meatspace/tabs/AlcoholTab.jsx:624',
  'src/components/meatspace/tabs/AlcoholTab.jsx:635',
  'src/components/meatspace/tabs/GenomeTab.jsx:859',
  'src/components/meatspace/tabs/LifestyleTab.jsx:163',
  'src/components/meatspace/tabs/LifestyleTab.jsx:184',
  'src/components/meatspace/tabs/LifestyleTab.jsx:243',
  'src/components/meatspace/tabs/NicotineTab.jsx:254',
  'src/components/meatspace/tabs/NicotineTab.jsx:261',
  'src/components/meatspace/tabs/NicotineTab.jsx:295',
  'src/components/meatspace/tabs/NicotineTab.jsx:302',
  'src/components/meatspace/tabs/NicotineTab.jsx:435',
  'src/components/meatspace/tabs/NicotineTab.jsx:456',
  'src/components/meatspace/tabs/NicotineTab.jsx:464',
  'src/components/meatspace/tabs/NicotineTab.jsx:473',
  'src/components/media/CollectionPickerShell.jsx:216',
  'src/components/media/CollectionPickerShell.jsx:239',
  'src/components/messages/InboxTab.jsx:381',
  'src/components/music/AlbumsManager.jsx:328',
  'src/components/music/AlbumsManager.jsx:346',
  'src/components/music/AlbumsManager.jsx:349',
  'src/components/music/ArtistsManager.jsx:273',
  'src/components/music/ArtistsManager.jsx:283',
  'src/components/music/ArtistsManager.jsx:395',
  'src/components/music/MusicGenPanel.jsx:324',
  'src/components/music/TracksManager.jsx:397',
  'src/components/pipeline/CanonCard.jsx:257',
  'src/components/pipeline/arcCanvas/AddSeasonRow.jsx:44',
  'src/components/pipeline/arcCanvas/DeriveFromManuscriptPreview.jsx:103',
  'src/components/pipeline/arcCanvas/SeasonActions.jsx:93',
  'src/components/pipeline/arcCanvas/SeasonEditor.jsx:46',
  'src/components/pipeline/arcCanvas/SeasonEditor.jsx:54',
  'src/components/pipeline/arcCanvas/SeasonEditor.jsx:65',
  'src/components/pipeline/arcCanvas/SeasonEditor.jsx:83',
  'src/components/pipeline/arcCanvas/SeasonEditor.jsx:91',
  'src/components/pipeline/arcCanvas/TickingClockEditor.jsx:38',
  'src/components/pipeline/stages/IdeaStage.jsx:94',
  'src/components/pipeline/stages/StoryboardsStage.jsx:510',
  'src/components/pipeline/stages/StoryboardsStage.jsx:745',
  'src/components/settings/VoiceTab.jsx:358',
  'src/components/settings/VoiceTab.jsx:443',
  'src/components/settings/VoiceTab.jsx:482',
  'src/components/settings/VoiceTab.jsx:595',
  'src/components/settings/VoiceTab.jsx:603',
  'src/components/settings/VoiceTab.jsx:611',
  'src/components/settings/VoiceTab.jsx:619',
  'src/components/settings/VoiceTab.jsx:757',
  'src/components/settings/VoiceTab.jsx:766',
  'src/components/settings/VoiceTab.jsx:871',
  'src/components/settings/VoiceTab.jsx:885',
  'src/components/sharing/DuplicateGroup.jsx:67',
  'src/components/shell/TerminalHotKeys.jsx:56',
  'src/components/universe/CharacterDetailEditor.jsx:174',
  'src/components/universeBuilder/CompositeSheetsEditor.jsx:134',
  'src/components/universeBuilder/CompositeSheetsEditor.jsx:193',
  'src/components/universeBuilder/InfluenceChipsInput.jsx:132',
  'src/components/universeBuilder/UniverseBibleTab.jsx:338',
  'src/components/universeBuilder/UniverseBuilderPage.jsx:497',
  'src/components/universeBuilder/UniverseCategoryEditor.jsx:254',
  'src/components/universeBuilder/UniverseCategoryEditor.jsx:316',
  'src/components/universeBuilder/UniverseCategoryEditor.jsx:434',
  'src/components/universeBuilder/UniverseTrunkPanels.jsx:92',
  'src/components/voice/VoiceWidget.jsx:752',
  'src/components/wiki/tabs/SearchTab.jsx:31',
  'src/components/writers-room/LibraryPane.jsx:168',
  'src/components/writers-room/LibraryPane.jsx:185',
  'src/pages/AIProviders.jsx:1390',
  'src/pages/AIProviders.jsx:1437',
  'src/pages/AIProviders.jsx:1444',
  'src/pages/Authors.jsx:300',
  'src/pages/Authors.jsx:413',
  'src/pages/Browser.jsx:446',
  'src/pages/CharacterSheet.jsx:522',
  'src/pages/CharacterSheet.jsx:738',
  'src/pages/CharacterSheet.jsx:745',
  'src/pages/CharacterSheet.jsx:770',
  'src/pages/CharacterSheet.jsx:777',
  'src/pages/CharacterSheet.jsx:802',
  'src/pages/CharacterSheet.jsx:809',
  'src/pages/CharacterSheet.jsx:818',
  'src/pages/GitHub.jsx:229',
  'src/pages/GitHub.jsx:388',
  'src/pages/GitHub.jsx:395',
  'src/pages/MediaCollectionDetail.jsx:346',
  'src/pages/MoodBoardDetail.jsx:606',
  'src/pages/PipelineSeries.jsx:339',
  'src/pages/PipelineSeries.jsx:354',
  'src/pages/PipelineSeries.jsx:364',
  'src/pages/Sharing.jsx:317',
  'src/pages/Sharing.jsx:325',
  'src/pages/StackerNews.jsx:474',
  'src/pages/StackerNews.jsx:566',
  'src/pages/StackerNews.jsx:567',
  'src/pages/StackerNews.jsx:587',
  'src/pages/StackerNews.jsx:588',
  'src/pages/StackerNews.jsx:597',
  'src/pages/StackerNews.jsx:640',
  'src/pages/VideoTimeline.jsx:73',
  'src/pages/VideoTimelineEditor.jsx:530',
  'src/pages/VideoTimelineEditor.jsx:627',
]);

describe('a11y conventions', () => {
  // Modal.jsx IS the shared implementation; Drawer and Layout use the same
  // backdrop treatment for a slide-in panel / mobile nav scrim, both of which
  // already own Esc + focus handling of their own.
  // MediaLightbox documents its opt-out at the top of the file (viewport-edge
  // chevrons + a layered Esc cascade Modal's stack would swallow) and supplies
  // the dialog semantics itself: role="dialog"/aria-modal, useFocusTrap, and a
  // window-level Esc handler.
  const MODAL_BACKDROP_ALLOWLIST = new Set([
    'src/components/ui/Modal.jsx',
    'src/components/Drawer.jsx',
    'src/components/Layout.jsx',
    'src/components/media/MediaLightbox.jsx',
  ]);

  it('routes full-screen dark overlays through the shared <Modal>', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      if (MODAL_BACKDROP_ALLOWLIST.has(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      // Only a dimming backdrop counts — `fixed inset-0` alone is also used for
      // non-modal chrome (HUD panels, drag overlays, canvas layers).
      const re = /fixed inset-0[^"'`]*bg-black\//g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Hand-rolled modal backdrop — use components/ui/Modal.jsx (focus trap + Esc stack + role=dialog):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('marks toggle-switch buttons with role="switch"', () => {
    // Pill-track dimensions used by the hand-rolled toggles in this codebase.
    // A switch is always a fixed-size rounded-full track roughly twice as wide
    // as it is tall; ordinary rounded-full buttons (icon buttons, chips) don't
    // pin both dimensions like this.
    const TRACK_SIZES = /\b(h-6 w-11|w-11 h-6|w-10 h-5|h-5 w-10|h-5 w-9|w-9 h-5|h-8 w-14|w-14 h-8|h-7 w-12|w-12 h-7)\b/;
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag) continue;
        if (!/rounded-full/.test(tag) || !TRACK_SIZES.test(tag)) continue;
        if (/role="switch"/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Toggle-switch button without role="switch" + aria-checked — prefer components/ToggleSwitch.jsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps every file input focusable and label-activated', () => {
    // Two failures ride on the same markup, and neither reproduces for the
    // author: `display:none` (Tailwind `hidden`) drops the input from the tab
    // order AND the a11y tree, and a `<button onClick={ref.current.click()}>`
    // paired with it is a synthetic click several engines refuse to honor —
    // notably WebKit with PortOS installed as a standalone PWA, which is how it
    // gets opened from a second machine over the tailnet. The picker simply
    // never appears. components/ui/FilePickerButton.jsx is the shared fix
    // (sr-only input + a real <label for>); this test is what stops the old
    // idiom from creeping back in one component at a time.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<input\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<input'.length);
        // Match against the whole opening tag, not a quoted-attribute-shaped
        // regex: `type='file'` / `type={'file'}` and a `hidden` arriving via a
        // template literal or ternary (`className={cond ? 'hidden' : ''}`) are
        // the same bug, and a quote-specific pattern waves them through.
        if (!tag || !/\btype\s*=\s*[{'"]*\s*['"]?file\b/.test(tag)) continue;
        const hidden = /\bhidden\b/.test(tag) || /display:\s*['"]?none/.test(tag);
        const ariaHidden = /aria-hidden/.test(tag);
        const untabbable = /tabIndex\s*=\s*\{\s*-1\s*\}/.test(tag);
        if (!hidden && !ariaHidden && !untabbable) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `File input hidden from keyboard/AT — use components/ui/FilePickerButton.jsx (sr-only input + native <label for> activation), never className="hidden" / aria-hidden / tabIndex={-1} / display:none:\n${offenders.join('\n')}`).toEqual([]);
  });

  // A programmatic ref click is legitimate for a synthesized <a download> — the
  // rule below is about file inputs, so real non-input uses get an escape hatch
  // (mirroring MODAL_BACKDROP_ALLOWLIST) rather than a misleading failure.
  const REF_CLICK_ALLOWLIST = new Set([]);

  it('never opens a file picker with a programmatic ref click', () => {
    // The other half of the same bug: even a correctly-focusable input is
    // unopenable in those engines if a button reaches over and clicks it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      if (REF_CLICK_ALLOWLIST.has(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /\.current\s*\??\.\s*click\(\)/g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Programmatic .click() on a ref — if it targets a file input the picker never opens in WebKit/PWA; use components/ui/FilePickerButton.jsx. If the ref is genuinely NOT a file input (e.g. a synthesized <a download>), add the file to REF_CLICK_ALLOWLIST above with a comment:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('names every never-dismissing toast that cannot name itself', () => {
    // A `duration: Infinity` toast folds into an icon-only pill after
    // COLLAPSE_AFTER_MS so it stops covering the page (components/ui/Toast.jsx).
    // The pill takes its accessible name from string content — but JSX and
    // render-prop content have no text to take, so without `label` the whole
    // name is "Show notification" and the notice becomes unidentifiable to a
    // screen reader for the rest of its (unbounded) life. Nothing at runtime
    // complains, so this is the only thing that catches it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /\btoast(?:\.\w+)?\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const call = balancedCallAt(src, re.lastIndex - 1);
        if (!call || !/\bduration:\s*Infinity\b/.test(call)) continue;
        // Only content that demonstrably isn't a string needs `label`: inline
        // JSX and render props. A literal or a variable is left alone — the
        // pill reads a string straight off `t.content`.
        const firstArg = call.slice(1).trimStart();
        const isJsx = firstArg.startsWith('<');
        const isRenderProp = /^(\([^)]*\)|\w+)\s*=>/.test(firstArg);
        if (!isJsx && !isRenderProp) continue;
        if (/\blabel:/.test(call)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `A duration: Infinity toast with JSX/render-prop content must pass \`label\` — it collapses to a pill that has no other accessible name (see COLLAPSE_AFTER_MS in components/ui/Toast.jsx):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('slices toast calls whose JSX text contains an apostrophe', () => {
    // The rule above is only as good as the slicer. An apostrophe in JSX text
    // opens a "string" that never closes, so the scan runs past the closing
    // paren — and a `null` slice is skipped silently, letting the exact shape
    // the rule targets (JSX content, no `label`) ship unflagged.
    const jsx = `toast(<div>You're out of sync</div>, { duration: Infinity })`;
    expect(balancedCallAt(jsx, jsx.indexOf('('))).toContain('duration: Infinity');

    // Skipping strings still has to win where it matters: a `)` inside a
    // string literal must not close the call early.
    const str = `toast('done (mostly)', { duration: Infinity })`;
    expect(balancedCallAt(str, str.indexOf('('))).toBe(str.slice(str.indexOf('(')));
  });

  it('gives every role="switch" an aria-checked state', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || !/role="switch"/.test(tag)) continue;
        if (/aria-checked/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `role="switch" without aria-checked:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every icon-only button an accessible name', () => {
    // A <button> whose entire body is an icon (including one chosen by a
    // ternary, e.g. play/pause, expand/collapse) has no text content for a
    // screen reader to announce. `title` alone doesn't fill that gap — it's
    // mouse-hover-only (no touch discoverability, and this app is opened from
    // other devices over the tailnet) and browser/AT support for `title` as
    // the accessible name is inconsistent. aria-label (or aria-labelledby) is
    // required; media/MediaCard.jsx's Annotate button (title + a paired
    // aria-label) is the existing convention.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || tag.endsWith('/>')) continue; // self-closing — no body to judge
        if (/\baria-label\s*=/.test(tag) || /\baria-labelledby\s*=/.test(tag)) continue;
        const openEnd = m.index + tag.length;
        const body = findButtonBody(src, openEnd);
        if (body === null || !isIconOnlyBody(body)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Icon-only <button> with no aria-label/aria-labelledby — title alone isn't touch-discoverable and isn't reliably read as the accessible name; see media/MediaCard.jsx's Annotate button for the convention:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every input an accessible name', () => {
    // These controls live in compact peer-management rows where visible labels
    // would break the layout. Keep explicit names on each input so placeholders
    // never become their only screen-reader context.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const scanSrc = maskComments(src);
      const re = /<input\b/g;
      let m;
      while ((m = re.exec(scanSrc))) {
        const tag = openingTagAt(scanSrc, m.index, '<input'.length);
        const location = `${file}:${lineOf(src, m.index)}`;
        if (!tag || hasAccessibleInputName(scanSrc, tag, m.index) || PREEXISTING_INPUT_NAME_ALLOWLIST.has(location)) continue;
        offenders.push(location);
      }
    }
    expect(offenders, `Input without an accessible name — add aria-label/aria-labelledby or an explicit/implicit <label>, or exclude type="hidden":\n${offenders.join('\n')}`).toEqual([]);
  });

  it('meets the 44px touch-target minimum on Close buttons', () => {
    // Close buttons keep shipping sized to their bare icon (w-4 h-4, p-1,
    // p-1.5) instead of a real tap target. components/Drawer.jsx:106 is the
    // convention: min-h-[44px] min-w-[44px] + flex items-center
    // justify-center, so the icon stays centered in the larger box.
    //
    // `inset-0` buttons are exempt: a full-bleed tap-anywhere-to-dismiss
    // backdrop (e.g. brain/tabs/DailyLogTab.jsx's mobile history scrim)
    // already covers the entire screen/panel, so a min-w/min-h floor is
    // meaningless — the element's box is already forced to fill its
    // positioned ancestor.
    // Matches both a literal `aria-label="Close…"` and an expression form
    // `aria-label={cond ? 'Close panel' : …}` / {`Close ${x}`} / {closeLabel}.
    // Scanning only the literal form is how a live 16px close button in
    // apps/DeployPanel.jsx (dynamic label, no sizing at all) hid from this
    // guard while it reported zero offenders — the canonical Drawer.jsx close
    // button uses a dynamic label too, so the literal-only form misses the
    // exact shape the convention was written from.
    const CLOSE_LABEL_RE = /aria-label\s*=\s*(?:"Close[^"]*"|\{[^}]*(?:['"`]Close|[Cc]loseLabel)[^}]*\})/;
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || !CLOSE_LABEL_RE.test(tag)) continue;
        if (/\binset-0\b/.test(tag)) continue;
        const clsMatch = tag.match(/className\s*=\s*"([^"]*)"/);
        if (!clsMatch) continue; // dynamic className — reviewed by hand, not scanned here
        if (hasFortyFourMinTouchTarget(clsMatch[1])) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Close button under the 44px touch-target minimum — add min-h-[44px] min-w-[44px] + flex items-center justify-center (see Drawer.jsx:106):\n${offenders.join('\n')}`).toEqual([]);
  });
});
