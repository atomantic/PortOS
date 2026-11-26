/**
 * Accessibility conventions: keyboard drag sensors and native drag-and-drop.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { trackedJsxFiles, trackedSourceFiles, maskedSourceOf, rawSourceOf, openingTagAt, forEachOpeningTag, lineOf } from '../../a11yScanCore.js';

describe('a11y conventions: dnd', () => {
  it('registers a KeyboardSensor in every DndContext (#7243)', () => {
    // `useDraggable`/`useSortable` return `attributes` that UNCONDITIONALLY
    // carry role="button", tabIndex={0}, aria-roledescription="draggable" and
    // an aria-describedby pointing at the module's "press the space bar to
    // pick up" instruction text. So a DndContext registered with PointerSensor
    // alone is worse than a missing feature: every handle is a tab stop that
    // tells the user to press a key nothing is listening for.
    //
    // #6911 fixed KanbanBoard and three siblings kept the defect, because
    // nothing asked the question tree-wide. This is that question. It is
    // file-local on purpose — every DndContext in this tree builds its sensors
    // in the same module — so a future call site that imports its sensors from
    // elsewhere should extend the rule rather than be quietly exempted.
    //
    // Which getter to pass is the surface's call: a SortableContext wants
    // the owned module's `sortableKeyboardCoordinates`, free `useDroppable`
    // zones want `createFreeDroppableKeyboardCoordinates` from
    // lib/dndKeyboardCoordinates.js, and a board with its own geometry writes
    // one (KanbanBoard.jsx's `kanbanKeyboardCoordinates`).
    const dndImports = src => {
      const re = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+lib\/dnd\/index\.js['"]/g;
      const bindings = new Map();
      let m;
      while ((m = re.exec(src))) {
        for (const part of m[1].split(',')) {
          const [imported, local] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
          if (imported) bindings.set(imported, local || imported);
        }
      }
      return bindings;
    };

    // Blank out every string literal before looking for the registration call.
    // Comments are already masked, but a quoted `"useSensor(KeyboardSensor)"`
    // in a title or a className would otherwise forge the exemption — and the
    // forged text would be invisible in review, which is the same trap the
    // clickable-element rule above is written around. Blanking preserves both
    // length and newlines so every index into the result still names the line
    // it names in the original.
    const withoutStringLiterals = (src) => src.replace(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      (literal) => literal[0] + literal.slice(1, -1).replace(/[^\n]/g, ' ') + literal.at(-1),
    );

    // The argument list of the call whose `(` follows `from`, brace/paren
    // balanced so a nested `useSensor(P, { activationConstraint: {…} })` does
    // not end it early.
    const balancedSliceAt = (src, from, open, close) => {
      const start = src.indexOf(open, from);
      if (start === -1) return null;
      let depth = 0;
      for (let i = start; i < src.length; i += 1) {
        if (src[i] === open) depth += 1;
        else if (src[i] === close) {
          depth -= 1;
          if (depth === 0) return src.slice(start + 1, i);
        }
      }
      return null;
    };

    // The sensor list THIS mount was handed: either `sensors={useSensors(…)}`
    // written inline, or the `useSensors(…)` call the named binding resolves to.
    //
    // Returns null when the expression is some other shape — a call, an array
    // literal, a prop — and the caller then falls back to the file-wide
    // question. That fallback is deliberately the conservative direction: a
    // spelling this cannot read is not evidence of a missing sensor, and a
    // tree-wide guard that FALSELY fails a correct change costs more than one
    // that misses an exotic shape. Widen the resolver when a real call site
    // needs it rather than guessing.
    //
    // A name declared more than once is likewise unresolvable, not "the first
    // one wins" — two components in one file each declaring `const sensors =
    // useSensors(…)` would otherwise be checked against whichever came first,
    // which both hides a pointer-only sibling AND falsely flags a correct one
    // when the order is reversed. Same rule, same reason, as the shim lookup
    // the clickable-element scan above uses.
    const sensorListFor = (src, tagIndex, useSensorsLocal) => {
      if (!useSensorsLocal) return null;
      const tag = openingTagAt(src, tagIndex);
      const expr = tag && balancedSliceAt(tag, tag.indexOf('sensors='), '{', '}')?.trim();
      if (!expr) return null;
      if (expr.startsWith(`${useSensorsLocal}(`)) return balancedSliceAt(expr, 0, '(', ')');
      if (!/^[\w$]+$/.test(expr)) return null;
      const decls = [...src.matchAll(new RegExp(`(?:const|let|var)\\s+${expr}\\s*=`, 'g'))];
      if (decls.length !== 1) return null;
      const assignsUseSensors = new RegExp(`(?:const|let|var)\\s+${expr}\\s*=\\s*${useSensorsLocal}\\s*\\(`);
      return assignsUseSensors.test(src.slice(decls[0].index))
        ? balancedSliceAt(src, decls[0].index, '(', ')')
        : null;
    };

    // Read off the import clause and the call expression, never off raw text,
    // and ask the question once per MOUNT rather than once per file — a file
    // holding a keyboard-enabled context beside a pointer-only one must not
    // have the first one exempt the second.
    // NB: the import clause is read off the source with its strings INTACT —
    // the module specifier is itself a string literal, so resolving the local
    // names against a blanked copy finds no dnd-kit import at all and the whole
    // rule silently passes. Blanking applies only to the text handed to
    // `registers`, which is the one place a literal could forge a match.
    const offendersIn = (file, src) => {
      const core = dndImports(src);
      const contextLocal = core.get('DndContext');
      if (!contextLocal) return [];
      const sensorLocal = core.get('KeyboardSensor');
      const useSensorLocal = core.get('useSensor');
      const useSensorsLocal = core.get('useSensors');
      const registers = (text) => Boolean(sensorLocal && useSensorLocal && text)
        && new RegExp(`\\b${useSensorLocal}\\s*\\(\\s*${sensorLocal}\\b`).test(withoutStringLiterals(text));

      const offenders = [];
      for (const { index } of forEachOpeningTag(src, contextLocal)) {
        if (registers(sensorListFor(src, index, useSensorsLocal) ?? src)) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
      return offenders;
    };

    // Probe first — the tree is green, so nothing in it pins what the matcher
    // rejects, and a silent change of shape would turn the rule vacuous.
    const probe = (src) => offendersIn('probe.jsx', src);
    const IMPORT_BOTH = "import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '../lib/dnd/index.js';";
    const IMPORT_POINTER = "import { DndContext, PointerSensor, useSensor, useSensors } from '../lib/dnd/index.js';";
    expect(probe(`${IMPORT_POINTER}\nconst s = useSensor(PointerSensor);\n<DndContext sensors={s} />`)).toEqual(['probe.jsx:3']);
    expect(probe(`${IMPORT_BOTH}\nconst s = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter }));\n<DndContext sensors={s} />`)).toEqual([]);
    // An aliased import is the same registration under another name…
    expect(probe("import { DndContext as Dnd, KeyboardSensor as KS, useSensor as sensor } from '../lib/dnd/index.js';\nconst s = sensor(KS, {});\n<Dnd sensors={s} />")).toEqual([]);
    // …and importing the symbol without ever registering it is not.
    expect(probe(`${IMPORT_BOTH}\nconst s = useSensor(PointerSensor);\n<DndContext sensors={s} />`)).toEqual(['probe.jsx:3']);
    // Neither is a quoted mention — and it must be pinned against an import
    // list that ALREADY has KeyboardSensor in it, or the case passes for the
    // unrelated reason that the symbol was never imported, and the forgery
    // branch is never exercised at all.
    expect(probe(`${IMPORT_BOTH}\nconst s = useSensor(PointerSensor);\n<DndContext sensors={s} title="useSensor(KeyboardSensor)" />`)).toEqual(['probe.jsx:3']);
    expect(probe(`${IMPORT_BOTH}\nconst label = \`useSensor(KeyboardSensor)\`;\n<DndContext sensors={useSensor(PointerSensor)} />`)).toEqual(['probe.jsx:3']);
    // …and blanking the literals must not shift the reported line, whether the
    // literal carries an escape or a real newline.
    expect(probe(`${IMPORT_BOTH}\nconst note = "a\\nb";\n<DndContext sensors={useSensor(PointerSensor)} />`)).toEqual(['probe.jsx:3']);
    expect(probe(`${IMPORT_BOTH}\nconst note = \`one\ntwo\`;\n<DndContext sensors={useSensor(PointerSensor)} />`)).toEqual(['probe.jsx:4']);
    // Nor does a same-named import from some other module count.
    expect(probe(`${IMPORT_POINTER}\nimport { KeyboardSensor, useSensor } from './fake';\nconst s = useSensor(KeyboardSensor);\n<DndContext sensors={s} />`)).toEqual(['probe.jsx:4']);

    // The list is resolved per MOUNT, so one keyboard-enabled context cannot
    // exempt a pointer-only sibling in the same file — the false negative a
    // file-wide search leaves behind.
    const TWO_CONTEXTS = `${IMPORT_BOTH}
const withKeys = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter }));
const pointerOnly = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
<><DndContext sensors={withKeys} /><DndContext sensors={pointerOnly} /></>`;
    expect(probe(TWO_CONTEXTS)).toEqual(['probe.jsx:4']);
    // An inline list resolves the same way, nested option braces and all.
    expect(probe(`${IMPORT_BOTH}\n<DndContext sensors={useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))} />`)).toEqual(['probe.jsx:2']);
    expect(probe(`${IMPORT_BOTH}\n<DndContext sensors={useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))} />`)).toEqual([]);
    // A `sensors` expression this cannot resolve falls back to the file-wide
    // question rather than reporting a context it never read — the conservative
    // direction, since a guard that falsely fails a correct change is worse
    // than one that misses an exotic spelling.
    expect(probe(`${IMPORT_BOTH}\nconst s = useSensors(useSensor(KeyboardSensor));\n<DndContext sensors={makeSensors()} />`)).toEqual([]);
    // A name declared twice is unresolvable for the same reason: resolving to
    // whichever declaration came first would hide the pointer-only component
    // here, and FALSELY FLAG the keyboard-enabled one if the two were reversed.
    const DUPLICATE_NAME = `${IMPORT_BOTH}
function A() { const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor)); return <DndContext sensors={sensors} />; }
function B() { const sensors = useSensors(useSensor(PointerSensor)); return <DndContext sensors={sensors} />; }`;
    expect(probe(DUPLICATE_NAME)).toEqual([]);
    // …and with no keyboard registration anywhere, the fallback still reports
    // BOTH mounts, so the duplicate-name branch is a widening of scope, not an
    // exemption.
    expect(probe(DUPLICATE_NAME.replaceAll(', useSensor(KeyboardSensor)', ''))).toEqual(['probe.jsx:2', 'probe.jsx:3']);
    // A file that never mounts a DndContext is out of the rule's remit, even
    // when it uses dnd-kit for something else.
    expect(probe("import { useDraggable } from '../lib/dnd/index.js';\nconst d = useDraggable({ id });")).toEqual([]);

    // `maskComments` is the most expensive routine in this file, so mask only
    // the handful of files that mention the drag-and-drop module at all — the raw substring is a
    // superset of "imports DndContext", and a commented-out import is still
    // rejected because the masked source is what `offendersIn` then reads.
    const scanned = trackedSourceFiles().filter((file) => rawSourceOf(file).includes('lib/dnd/index.js'));
    const withContext = scanned.filter((file) => dndImports(maskedSourceOf(file)).has('DndContext'));
    // Assert the scan really found the live call sites, so a change to the file
    // walker can't turn this into a pass over zero DndContexts.
    expect(withContext.length, 'no client source mounts a DndContext — has trackedSourceFiles() changed its path shape?').toBeGreaterThanOrEqual(7);

    const offenders = [];
    for (const file of withContext) offenders.push(...offendersIn(file, maskedSourceOf(file)));
    expect(offenders, `DndContext registered without a KeyboardSensor — every drag handle already announces itself as draggable and tells the user to press Space, so a pointer-only sensor list is a WCAG 2.1.1 failure. Add useSensor(KeyboardSensor, { coordinateGetter }) (sortableKeyboardCoordinates for a SortableContext, createFreeDroppableKeyboardCoordinates from lib/dndKeyboardCoordinates.js for free droppables):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('never reintroduces native HTML5 drag-and-drop (#8120)', () => {
    // A JSX `draggable` attribute means the browser's OWN drag-and-drop, which
    // has no keyboard or assistive-technology path at all — that gap is
    // exactly what the tree-wide dnd-kit migration (#6911, #7243, #8120)
    // replaced. Brain → Links was the last native site (buckets and chips,
    // both via `dataTransfer`); see `components/brain/links/bucketDnd.js` for
    // the worked multi-container (bucket-reorder + cross-bucket chip-reorder)
    // example this rule now guards. `draggable={false}` (or `"false"`) is the
    // one legitimate spelling left: it suppresses the browser's default drag
    // on an `<a>`/`<img>` nested inside a dnd-kit handle so it stops fighting
    // the pointer sensor — see the anchors in `LinkChip.jsx`.
    const DRAGGABLE_ATTR = /(?:^|\s)draggable(?:\s*=\s*(?:\{([^}]*)\}|"([^"]*)"|'([^']*)'))?(?=[\s/>])/;
    const offendersIn = (file, src) => {
      const out = [];
      for (const node of forEachOpeningTag(src, undefined)) {
        const m = DRAGGABLE_ATTR.exec(node.tag);
        if (!m) continue;
        const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (value === 'false' || value === "'false'" || value === '"false"') continue;
        out.push(`${file}:${lineOf(src, node.index)}`);
      }
      return out;
    };

    // Probe first — the tree is green by construction, so nothing left in it
    // pins what the walk rejects.
    expect(offendersIn('probe.jsx', '<div draggable>x</div>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<div draggable={true}>x</div>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<div draggable="true">x</div>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<div draggable={isDraggable}>x</div>')).toEqual(['probe.jsx:1']);
    // …the one exempt spelling, in both a JSX-expression and a plain string:
    expect(offendersIn('probe.jsx', '<div draggable={false}>x</div>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<a draggable="false" href="x">x</a>')).toEqual([]);
    // A bare mention of the word (prose, an object key) is not the JSX attribute.
    expect(offendersIn('probe.jsx', '<div>draggable</div>')).toEqual([]);
    expect(offendersIn('probe.jsx', "const draggable = true;\n<div />")).toEqual([]);

    const offenders = [];
    for (const file of trackedJsxFiles()) offenders.push(...offendersIn(file, maskedSourceOf(file)));
    expect(offenders, `A JSX draggable attribute other than draggable={false} — native HTML5 drag-and-drop has no keyboard path. Use the shared drag-and-drop module (useDraggable/useDroppable + a KeyboardSensor); components/brain/links/bucketDnd.js is a worked multi-container example:\n${offenders.join('\n')}`).toEqual([]);
  });
});
