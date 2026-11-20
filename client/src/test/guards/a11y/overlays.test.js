/**
 * Accessibility conventions: overlay, switch and switch hit-area rules.
 * Shared scanner: `src/test/a11yScan*.js`; rule overview in `a11yScanCore.js`.
 */
import { describe, it, expect } from 'vitest';
import { trackedJsxFiles, rawSourceOf, forEachOpeningTag, lineOf } from '../../a11yScanCore.js';
import { tokenPx } from '../../a11yScanNames.js';

describe('a11y conventions: overlays', () => {
  // Modal.jsx IS the shared implementation; Drawer and Layout use the same
  // backdrop treatment for a slide-in panel / mobile nav scrim, both of which
  // already own Esc + focus handling of their own.
  // MediaLightbox documents its opt-out at the top of the file (viewport-edge
  // chevrons + a layered Esc cascade Modal's stack would swallow) and supplies
  // the dialog semantics itself: role="dialog"/aria-modal, useFocusTrap, and a
  // window-level Esc handler.
  // MoodBoardDetail's phone tool sheet is the same element as the desktop tool
  // rail, so its tools stay mounted (running jobs keep state) across open,
  // close and resize; it carries role="dialog", useFocusTrap and useEscLayer.
  const MODAL_BACKDROP_ALLOWLIST = new Set([
    'src/components/ui/Modal.jsx',
    'src/components/Drawer.jsx',
    'src/components/Layout.jsx',
    'src/components/media/MediaLightbox.jsx',
    'src/pages/MoodBoardDetail.jsx',
  ]);

  it('routes full-screen dark overlays through the shared <Modal>', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      if (MODAL_BACKDROP_ALLOWLIST.has(file)) continue;
      const src = rawSourceOf(file);
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
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'button')) {
        if (!/rounded-full/.test(tag) || !TRACK_SIZES.test(tag)) continue;
        if (/role="switch"/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `Toggle-switch button without role="switch" + aria-checked — prefer components/ToggleSwitch.jsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every hand-rolled role="switch" button a touch-size hit area (#15381)', () => {
    // ToggleSwitch.jsx grows its hit area on a coarse pointer. A switch built
    // elsewhere must carry its own: a >=44px height (base or pointer-coarse),
    // or a pointer-coarse before:-inset pseudo-element around the track.
    const SHARED = 'src/components/ToggleSwitch.jsx';
    // A `${constName}` in a template className resolves to that file's
    // `const constName = '...'` literal, so a shared class constant counts.
    const classOf = (tag, src) => {
      const m = tag.match(/className\s*=\s*(?:"([^"]*)"|\{\s*`([^`]*)`\s*\}|\{\s*"([^"]*)"\s*\})/);
      const raw = m ? (m[1] ?? m[2] ?? m[3]) : '';
      const consts = new Map([...src.matchAll(/const\s+(\w+)\s*=\s*'([^']*)'/g)].map((c) => [c[1], c[2]]));
      return raw.replace(/\$\{(\w+)\}/g, (_, name) => consts.get(name) ?? '');
    };
    // Effective hit height: the track's own height plus whatever a positioned
    // ::before grows it by. `-inset-N` grows both sides; `-top-N` / `-bottom-N`
    // one each. Coarse-pointer-prefixed tokens count, since that is the scope
    // the expansion is meant for.
    // On a coarse pointer a pointer-coarse utility overrides the base one for
    // that property; min-height is never overridden by height, so the used
    // height is the larger of the two after that override.
    const hitHeightPx = (cls) => {
      const all = cls.split(/\s+/).filter(Boolean);
      const base = all.filter((t) => !t.startsWith('pointer-coarse:'));
      const coarse = all.filter((t) => t.startsWith('pointer-coarse:')).map((t) => t.slice('pointer-coarse:'.length));
      const lastPx = (tokens, re) => {
        let v = null;
        for (const t of tokens) if (re.test(t)) v = tokenPx(t) ?? 0;
        return v;
      };
      const hOf = lastPx(coarse, /^h-/) ?? lastPx(base, /^h-/) ?? 0;
      const minOf = lastPx(coarse, /^min-h-/) ?? lastPx(base, /^min-h-/) ?? 0;
      const height = Math.max(hOf, minOf);

      // Pseudo-element growth only counts when this same class list positions
      // the control and the ::before is absolutely positioned against it.
      const stripped = [...base, ...coarse];
      const positioned = stripped.some((t) => ['relative', 'absolute', 'fixed', 'sticky'].includes(t));
      if (!positioned || !stripped.includes('before:absolute')) return height;
      const insetTok = stripped.map((t) => t.match(/^before:-(?:inset|inset-y)-(\d+(?:\.5)?)$/)).find(Boolean);
      if (insetTok) return height + 2 * parseFloat(insetTok[1]) * 4;
      const topTok = stripped.map((t) => t.match(/^before:-top-(\d+(?:\.5)?)$/)).find(Boolean);
      const bottomTok = stripped.map((t) => t.match(/^before:-bottom-(\d+(?:\.5)?)$/)).find(Boolean);
      // An empty absolute ::before stretches only when both edges are set.
      if (topTok && bottomTok) return height + (parseFloat(topTok[1]) + parseFloat(bottomTok[1])) * 4;
      return height;
    };
    const hasTouchHitArea = (cls) => hitHeightPx(cls) >= 44;
    const offendersIn = (file, src) => {
      const out = [];
      for (const node of forEachOpeningTag(src, 'button')) {
        if (!/role="switch"/.test(node.tag)) continue;
        if (hasTouchHitArea(classOf(node.tag, src))) continue;
        out.push(`${file}:${lineOf(src, node.index)}`);
      }
      return out;
    };

    // Probe first: the old hand-rolled 20px track must fail, and each accepted
    // hit-area form must pass, so a green run means "no offenders" for real.
    const probe = (cls) => offendersIn('probe.jsx', `<button type="button" role="switch" aria-checked={on} className="${cls}"><span /></button>`);
    expect(probe('shrink-0 w-10 h-5 rounded-full transition-colors relative')).toEqual(['probe.jsx:1']);
    expect(probe('relative inline-flex h-5 w-9 items-center rounded-full')).toEqual(['probe.jsx:1']);
    expect(probe('pointer-coarse:h-5 rounded-full')).toEqual(['probe.jsx:1']);
    expect(probe('min-h-[44px] sm:min-h-[28px] rounded-full')).toEqual([]);
    expect(probe('sm:min-h-[44px] rounded-full')).toEqual(['probe.jsx:1']);
    // h-5 (20px) plus -inset-2 is only 36px tall, so it stays an offender;
    // -inset-3 reaches 44px.
    expect(probe('pointer-coarse:before:absolute pointer-coarse:before:-inset-2 shrink-0 w-10 h-5 rounded-full')).toEqual(['probe.jsx:1']);
    // The ::before only grows a control that is itself positioned.
    expect(probe('relative pointer-coarse:before:absolute pointer-coarse:before:-inset-3 shrink-0 w-10 h-5 rounded-full')).toEqual([]);
    expect(probe('pointer-coarse:before:absolute pointer-coarse:before:-inset-3 shrink-0 w-10 h-5 rounded-full')).toEqual(['probe.jsx:1']);
    expect(probe('relative pointer-coarse:before:absolute pointer-coarse:before:-top-3 pointer-coarse:before:-bottom-3 h-5 rounded-full')).toEqual([]);
    // A lone edge offset does not stretch an empty absolute ::before.
    expect(probe('relative before:absolute before:-top-6 h-5 rounded-full')).toEqual(['probe.jsx:1']);
    expect(probe('relative pointer-coarse:before:-inset-x-3 h-5 rounded-full')).toEqual(['probe.jsx:1']);
    // A pointer-coarse height overrides the base one on a coarse pointer.
    expect(probe('h-11 pointer-coarse:h-5 rounded-full')).toEqual(['probe.jsx:1']);
    expect(probe('h-5 pointer-coarse:min-h-11 rounded-full')).toEqual([]);
    expect(probe('pointer-coarse:min-h-11 w-10 h-5 rounded-full')).toEqual([]);
    expect(probe('pointer-coarse:min-h-[44px] w-10 h-5 rounded-full')).toEqual([]);
    // Dynamic className: the template's static tokens are what count.
    expect(offendersIn('probe.jsx', '<button type="button" role="switch" aria-checked={on} className={`relative h-5 w-9 ${on ? "a" : "b"}`}><span /></button>')).toEqual(['probe.jsx:1']);
    // Not a switch: a rounded track button without role="switch" is out of this rule's remit.
    expect(offendersIn('probe.jsx', '<button type="button" className="h-5 w-10 rounded-full"><span /></button>')).toEqual([]);
    // The shared primitive is not exempt: its sm track is measured from its own
    // source (the SIZES track and the trackClass template), so a dropped
    // coarse-pointer expansion fails here. A bare track must still fail.
    const shared = rawSourceOf(SHARED);
    const smTrack = shared.match(/sm:\s*\{\s*track:\s*'([^']*)'/)?.[1] ?? '';
    const trackTemplate = shared.match(/const trackClass = `([^`]*)`/)?.[1] ?? '';
    expect(smTrack, 'ToggleSwitch sm track not found — has SIZES changed shape?').not.toBe('');
    expect(trackTemplate, 'ToggleSwitch trackClass not found — has it changed shape?').not.toBe('');
    expect(offendersIn(SHARED, `<button type="button" role="switch" className="${trackTemplate.replace('${s.track}', smTrack)}"></button>`)).toEqual([]);
    expect(offendersIn(SHARED, `<button type="button" role="switch" className="${smTrack}"></button>`)).toEqual([`${SHARED}:1`]);

    const offenders = [];
    // ToggleSwitch.jsx's track classes are assembled from SIZES, which a
    // literal scan cannot read; its sm track is measured above instead.
    for (const file of trackedJsxFiles()) {
      if (file !== SHARED) offenders.push(...offendersIn(file, rawSourceOf(file)));
    }
    expect(offenders, `role="switch" button under the 44px touch-target minimum — use components/ToggleSwitch.jsx, or give it min-h-[44px], or on a relative control pointer-coarse:before:absolute pointer-coarse:before:-inset-3 with an h-5 track:\n${offenders.join('\n')}`).toEqual([]);
  });

});
