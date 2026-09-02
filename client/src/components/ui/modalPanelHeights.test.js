import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Migration pin for issue #5665.
 *
 * `Modal.jsx` clamps its panel to the *visible* viewport (`max-h-dvh-cap` plus
 * a per-align `--dvh-inset`). A call site that re-adds its own `max-h-[NNvh]`
 * defeats that: the overlay is `fixed inset-0` — the small viewport under iOS
 * Safari's retractable chrome — and centres with `items-center`, so a taller
 * panel has its overflow split top and bottom and the dialog loses both its
 * title and its Save/Cancel row off-screen. On the long forms that also set
 * `closeOnEsc={false}` / `closeOnBackdrop={false}` there is then no way out.
 *
 * A caller that genuinely wants a *shorter* panel sets the cap instead:
 * `panelClassName="… [--dvh-cap:60dvh]"`, which still resolves against the
 * dynamic viewport.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ATTRIBUTE = 'panelClassName=';
const RAW_VH_RE = /max-h-\[[\d.]+vh\]/;

/**
 * Every `panelClassName=` attribute value in `source`, as raw text.
 *
 * A quoted literal is taken verbatim; a `{…}` expression is taken whole (brace
 * counting, so a ternary or template literal is captured entire rather than
 * truncated at the first `}`). Capturing the expression rather than parsing it
 * means a dynamic class string is still scanned for the banned idiom.
 */
function panelClassValues(source) {
  const values = [];
  let cursor = source.indexOf(ATTRIBUTE);
  while (cursor !== -1) {
    let i = cursor + ATTRIBUTE.length;
    const opener = source[i];
    if (opener === '"' || opener === "'") {
      const end = source.indexOf(opener, i + 1);
      if (end !== -1) values.push(source.slice(i + 1, end));
    } else if (opener === '{') {
      let depth = 0;
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      values.push(source.slice(cursor + ATTRIBUTE.length + 1, i));
    }
    cursor = source.indexOf(ATTRIBUTE, cursor + ATTRIBUTE.length);
  }
  return values;
}

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.jsx?$/.test(entry) && !/\.(test|spec)\.jsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('Modal panel heights', () => {
  it('extracts panelClassName values in every syntactic form a caller can use', () => {
    // Proves the sweep below can actually see an offender — otherwise a
    // collector that silently matched nothing would make it vacuously green.
    // The banned classes are interpolated rather than written out so Tailwind's
    // source scanner doesn't emit CSS for a fixture nothing renders.
    const vh = (n) => `max-h-[${n}vh]`;
    const fixture = `
      <Modal panelClassName="a ${vh(85)} b" />
      <Modal panelClassName={ 'c ${vh(80)}' } />
      <Modal panelClassName={\`d ${vh(42.5)}\`} />
      <Modal panelClassName={wide ? 'e ${vh(90)}' : 'f'} />
      <Modal panelClassName="clean [--dvh-cap:60dvh]" />
    `;
    const offenders = panelClassValues(fixture).filter((v) => RAW_VH_RE.test(v));
    expect(offenders).toHaveLength(4);
  });

  it('has no call site passing a raw viewport-height clamp in panelClassName', () => {
    const offenders = [];
    let scanned = 0;
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(ATTRIBUTE)) continue;
      for (const value of panelClassValues(source)) {
        scanned += 1;
        if (RAW_VH_RE.test(value)) offenders.push(`${relative(SRC_ROOT, file)}: ${value}`);
      }
    }
    // Reach check on the extracted values (not merely on files mentioning the
    // prop), so a parser that stopped matching fails loudly here.
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
