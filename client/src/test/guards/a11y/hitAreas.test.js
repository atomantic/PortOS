/**
 * Accessibility conventions: 44px hit areas and key-submit autofocus.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { escapeRegExp } from '../../../lib/textUtils.js';
import { trackedJsxFiles, maskedSourceOf, rawSourceOf, forEachOpeningTag, lineOf, findButtonBody, isIconOnlyButton } from '../../a11yScanCore.js';
import { hasFortyFourMinTouchTarget } from '../../a11yScanNames.js';

describe('a11y conventions: hitAreas', () => {
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
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'button')) {
        if (!CLOSE_LABEL_RE.test(tag)) continue;
        if (/\binset-0\b/.test(tag)) continue;
        const clsMatch = tag.match(/className\s*=\s*"([^"]*)"/);
        if (!clsMatch) continue; // dynamic className — reviewed by hand, not scanned here
        if (hasFortyFourMinTouchTarget(clsMatch[1])) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `Close button under the 44px touch-target minimum — add min-h-[44px] min-w-[44px] + flex items-center justify-center (see Drawer.jsx:106):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every icon-only button a touch-size hit area (#14416)', () => {
    // Covers every icon-only button, whose tap target is otherwise its 12-20px glyph. A
    // dense desktop row stays compact with `pointer-coarse:min-h-11
    // pointer-coarse:min-w-11`; bare <summary> rows get their touch height from
    // the base rule in src/index.css.
    // Each axis estimates the hit area from unprefixed size and padding tokens
    // (an `sm:` size does not apply on a phone) and must reach 44px. A
    // `pointer-coarse:` min size of 44px+ satisfies its axis.
    const MIN_TOUCH_PX = 44;
    const toPx = (v) => (v == null ? null : /^\d+(?:\.\d+)?$/.test(v) ? parseFloat(v) * 4 : null);
    const arbPx = (v) => {
      const m = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(v);
      return m ? parseFloat(m[1]) * (m[2] === 'rem' ? 16 : 1) : null;
    };
    const sizeOf = (v) => toPx(v) ?? arbPx(v);
    const iconPx = (src, node) => {
      const body = findButtonBody(src, node.contentStart) ?? '';
      const m = /\bsize=\{(\d+)\}/.exec(body);
      return m ? Number(m[1]) : 16;
    };
    const axisPx = (tokens, axis, icon) => {
      const dim = axis === 'h' ? 'h' : 'w';
      const pads = axis === 'h' ? ['py', 'pt', 'pb'] : ['px', 'pl', 'pr'];
      let minimum = 0;
      let fixed = null;
      let all = 0;
      let axial = null;
      const side = { a: null, b: null };
      for (const t of tokens) {
        const coarse = /^pointer-coarse:(?:min-)?(?:size|[hw])-(.+)$/.exec(t);
        if (coarse && (sizeOf(coarse[1]) ?? 0) >= MIN_TOUCH_PX) {
          const kind = /^pointer-coarse:(?:min-)?(size|[hw])-/.exec(t)[1];
          if (kind === 'size' || kind === dim) return Infinity;
        }
        let m = new RegExp(`^(min-)?(?:${dim}|size)-(.+)$`).exec(t);
        if (m) {
          const size = sizeOf(m[2]);
          if (m[1]) minimum = Math.max(minimum, size ?? 0);
          // Relative dimensions can shrink below the glyph inside a small parent.
          // Only a known size or independent minimum proves a touch-size box.
          else fixed = fixed === null ? (size ?? 0) : Math.min(fixed, size ?? 0);
        }
        m = /^p-(.+)$/.exec(t);
        if (m) all = sizeOf(m[1]) ?? 0;
        m = new RegExp(`^(?:${pads[0]})-(.+)$`).exec(t);
        if (m) axial = sizeOf(m[1]) ?? 0;
        m = new RegExp(`^(?:${pads[1]})-(.+)$`).exec(t);
        if (m) side.a = sizeOf(m[1]) ?? 0;
        m = new RegExp(`^(?:${pads[2]})-(.+)$`).exec(t);
        if (m) side.b = sizeOf(m[1]) ?? 0;
      }
      // Tailwind emits side-specific utilities after axis utilities regardless
      // of their order in className.
      const fallback = axial ?? all;
      const padding = (side.a ?? fallback) + (side.b ?? fallback);
      // With border-box sizing, a fixed size does not grow to fit its icon;
      // the box can only expand enough to contain its own padding.
      const box = fixed === null ? icon + padding : Math.max(fixed, padding);
      return Math.max(minimum, box);
    };
    const reachesTouchSize = (cls, icon) => {
      const tokens = cls.split(/\s+/).filter(Boolean);
      return axisPx(tokens, 'h', icon) >= MIN_TOUCH_PX && axisPx(tokens, 'w', icon) >= MIN_TOUCH_PX;
    };
    // A bare `className={BUTTON}` (or `${BUTTON}` inside a template) resolves to
    // a same-file `const BUTTON = '…'` string; without that the shared-constant
    // shape gave the scan no tokens and every such button passed (#14874).
    const constClass = (src, name) => {
      const m = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*(?:(["'])([^"']*)\\1|\`([^\`$]*)\`)\\s*;`).exec(src);
      return m ? (m[2] ?? m[3]) : null;
    };
    const literalClass = (tag, src = '') => {
      const quoted = /\bclassName=(["'])([^"']*)\1/.exec(tag);
      if (quoted) return quoted[2];
      const ident = /\bclassName=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag);
      if (ident) return constClass(src, ident[1]);
      const template = /\bclassName=\{`([^`]*)`\}/.exec(tag);
      // A template with no static classes is dynamic, reviewed by hand like the rules above.
      const statics = template
        ? template[1].replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_, name) => ` ${constClass(src, name) ?? ''} `).replace(/\$\{[^}]*\}/g, ' ')
        : '';
      return statics.trim() ? statics : null;
    };
    const offendersIn = (file, src) => {
      const out = [];
      for (const node of forEachOpeningTag(src, 'button')) {
        if (!isIconOnlyButton(src, node)) continue;
        const cls = literalClass(node.tag, src);
        if (cls == null || reachesTouchSize(cls, iconPx(src, node))) continue;
        out.push(`${file}:${lineOf(src, node.index)}`);
      }
      return out;
    };
    const probe = (markup) => offendersIn('probe.jsx', markup).length;
    // Same-file class constants are resolved, bare or inside a template (#14874).
    const BTN = "const BTN = 'inline-flex min-h-[44px] px-2';\n";
    expect(probe(BTN + '<button aria-label="Remove" className={BTN}><X size={14} /></button>')).toBe(1);
    expect(probe(BTN + '<button aria-label="Remove" className={`${BTN} ${on ? "a" : "b"}`}><X size={14} /></button>')).toBe(1);
    expect(probe("const BTN = 'min-h-[44px] min-w-[44px]';\n<button aria-label=\"Remove\" className={BTN}><X size={14} /></button>")).toBe(0);
    expect(probe('<button aria-label="Remove" className={importedCls}><X size={14} /></button>')).toBe(0);
    expect(probe('<button aria-label="Remove" className="text-gray-500"><X size={14} /></button>')).toBe(1);
    expect(probe('<button aria-label="Toggle" className={`p-1 ${on ? "a" : "b"}`}>{on ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1"><X size={14} /></button>')).toBe(0);
    expect(probe('<button aria-label="Remove" className="pointer-coarse:min-h-11 p-1"><X size={14} /></button>')).toBe(1);
    // 14px icon + p-2 is a ~30px square, under the 44px minimum.
    expect(probe('<button aria-label="Remove" className="p-2"><X size={14} /></button>')).toBe(1);
    // One dimension is not enough: 44px tall but ~30px wide.
    expect(probe('<button aria-label="Remove" className="min-h-[44px] px-2"><X size={14} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="min-h-10 min-w-10"><X size={14} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="min-h-[44px] min-w-[44px]"><X size={14} /></button>')).toBe(0);
    expect(probe('<button aria-label="Remove" className="h-11 w-11"><X size={14} /></button>')).toBe(0);
    expect(probe('<button aria-label="Remove" className="p-3"><X size={20} /></button>')).toBe(0);
    expect(probe('<button aria-label="Remove" className="p-3 px-0"><X size={20} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="p-3 pt-0 py-3"><X size={20} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="p-3 py-3 pt-0"><X size={20} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="h-2 w-2 p-3"><X size={20} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="h-2 w-2 min-h-11 min-w-11 p-3"><X size={20} /></button>')).toBe(0);
    // Relative sizes do not establish an unconditional 44px floor.
    for (const relative of ['full', '1/2', '[50%]', 'screen', 'dvh']) {
      const button = (minimum = '') => `<div className="h-4 w-4"><button aria-label="Remove" className="h-${relative} w-${relative} ${minimum}"><X size={14} /></button></div>`;
      expect(probe(button())).toBe(1);
      expect(probe(button('min-h-[44px] min-w-[44px]'))).toBe(0);
    }
    expect(probe('<button aria-label="Remove" className="h-full w-full p-3"><X size={20} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="flex-1"><X size={14} /></button>')).toBe(1);
    expect(probe('<button aria-label="Remove" className="sm:min-h-[44px] sm:min-w-[44px]"><X size={14} /></button>')).toBe(1);

    const offenders = trackedJsxFiles().flatMap((file) => offendersIn(file, rawSourceOf(file)));
    expect(offenders, `Icon-only <button> with a glyph-sized tap target — add pointer-coarse:min-h-11 pointer-coarse:min-w-11 (or min-h-[44px] min-w-[44px]):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps a 44px touch floor when a breakpoint shrinks a control (#15377)', () => {
    // Width is not pointer precision: an iPad at 768px is past `sm` and still
    // coarse. A class string that sets a ≥44px min on an axis and then shrinks
    // that axis at a width breakpoint must gate the shrink on `pointer-fine:`,
    // so coarse pointers keep the floor at every width. A `pointer-coarse:`
    // min of 44px+ on the same axis is an accepted alternative floor.
    const MIN_FLOOR_PX = 44;
    const pxOf = (v) => {
      const arb = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(v);
      if (arb) return parseFloat(arb[1]) * (arb[2] === 'rem' ? 16 : 1);
      return /^\d+$/.test(v) ? Number(v) * 4 : null;
    };
    // Height and width both count: `h-11 sm:h-8` shrinks a 44px box as surely as
    // `min-h-[44px] sm:min-h-0`. A max-h/max-w cap below 44px is also a shrink.
    const SHRINK = /^((?:[^:\s]+:)*)(?:min-|max-)?([hw])-(.+)$/;
    const offendersIn = (file, src) => {
      const out = [];
      for (const seg of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
        const tokens = (seg[1] ?? seg[2] ?? seg[3] ?? '').split(/\s+/).filter(Boolean);
        const floorOf = (t) => {
          const m = /^(?:pointer-coarse:)?(?:min-)?([hw])-(.+)$/.exec(t);
          return m && (pxOf(m[2]) ?? 0) >= MIN_FLOOR_PX ? m[1] : null;
        };
        const floors = new Set(tokens.filter((t) => !t.includes(':') || t.startsWith('pointer-coarse:')).map(floorOf).filter(Boolean));
        for (const axis of floors) {
          const coarseFloor = tokens.some((t) => t.startsWith('pointer-coarse:') && floorOf(t) === axis);
          const shrinks = tokens.some((t) => {
            const m = SHRINK.exec(t);
            if (!m || m[2] !== axis) return false;
            const variants = m[1].split(':').filter(Boolean);
            if (variants.includes('pointer-fine')) return false;
            if (!variants.some((v) => /^(?:sm|md|lg|xl|2xl|@.+)$/.test(v))) return false;
            const px = pxOf(m[3]);
            return px !== null && px < MIN_FLOOR_PX;
          });
          if (shrinks && !coarseFloor) out.push(`${file}:${lineOf(src, seg.index)}`);
        }
      }
      return out;
    };

    // Probe first: the shrink must be recognized, and the gated form must pass.
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] sm:min-h-0">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] pointer-fine:sm:min-h-0">x</button>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<button className="min-w-11 md:min-w-8">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] sm:min-h-[44px]">x</button>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<button className="sm:min-h-0 px-2">x</button>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] pointer-coarse:min-h-11 sm:min-h-0">x</button>')).toEqual([]);
    // Axes are independent: a 44px height does not excuse a shrunken width.
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] sm:min-w-0">x</button>')).toEqual([]);
    // Bare height/width floors and their breakpoint shrinks.
    expect(offendersIn('probe.jsx', '<button className="h-11 w-14 sm:h-8">x</button>')).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', '<button className="h-11 w-14 pointer-fine:sm:h-8">x</button>')).toEqual([]);
    expect(offendersIn('probe.jsx', '<button className="min-h-[44px] sm:max-h-[20px]">x</button>')).toEqual(['probe.jsx:1']);

    const offenders = trackedJsxFiles()
      .filter((file) => !/\.test\.jsx?$/.test(file))
      .flatMap((file) => offendersIn(file, rawSourceOf(file)));
    expect(offenders, `Breakpoint shrinks a 44px touch floor on every width, so tablets get a desktop-size target — gate the override with pointer-fine: (e.g. pointer-fine:sm:min-h-0):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('never autofocuses a button on a surface that submits with a key', () => {
    // The Enter that submits an answer is still down when the control it
    // reveals mounts and takes focus, so the browser activates that control off
    // the same keystroke — its keypress/keyup, or the first auto-repeat — and
    // whatever it was meant to reveal is gone in the tick it appeared. The
    // Morse copy drill showed a right/wrong verdict per question that no user
    // ever saw, which left a two-character drill an unlearnable coin flip.
    //
    // Scoped to files that submit on a key, because that is the whole vector: a
    // dialog's confirm button or a tutorial's Start button is autofocused for
    // good reason and nothing keys into it.
    const KEY_SUBMIT = /<form\b[^>]*onSubmit|key\s*[=!]==\s*['"]Enter['"]/;
    const offendersIn = (file, src) => {
      if (!KEY_SUBMIT.test(src)) return [];
      const out = [];
      for (const node of forEachOpeningTag(src, 'button')) {
        if (/(?:^|\s)autoFocus(?=[\s=/>])/.test(node.tag)) out.push(`${file}:${lineOf(src, node.index)}`);
      }
      return out;
    };

    // Probe first — the tree is green by construction, so nothing left in it
    // pins what the walk rejects.
    const form = '<form onSubmit={submit}><input autoFocus /></form>';
    expect(offendersIn('probe.jsx', `${form}<button autoFocus>Next</button>`)).toEqual(['probe.jsx:1']);
    expect(offendersIn('probe.jsx', `${form}<button onClick={next}>Next</button>`)).toEqual([]);
    // An autofocused INPUT is the point — only the button is the defect…
    expect(offendersIn('probe.jsx', form)).toEqual([]);
    // …and a surface nothing keys into keeps its autofocused button.
    expect(offendersIn('probe.jsx', '<button autoFocus>Start</button>')).toEqual([]);
    // An Enter-keyed handler counts as a key submit even with no <form>.
    expect(offendersIn('probe.jsx', "onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}\n<button autoFocus>Next</button>")).toEqual(['probe.jsx:2']);
    // A prop that merely starts with the same letters is not the attribute.
    expect(offendersIn('probe.jsx', `${form}<button autoFocusDelay={1}>Next</button>`)).toEqual([]);

    const offenders = [];
    for (const file of trackedJsxFiles()) offenders.push(...offendersIn(file, maskedSourceOf(file)));
    expect(offenders, `An autofocused <button> on a surface that submits with a key — the submitting keystroke activates it and skips whatever it revealed. Keep the submitting element focused (readOnly, not disabled), or move Enter-to-advance into a window handler gated on shouldIgnoreGlobalKey and leave the button unfocused (see client/src/AGENTS.md):\n${offenders.join('\n')}`).toEqual([]);
  });

});
