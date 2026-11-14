/**
 * Reads Higgsfield's public model catalog (the server-rendered pricing page, open.higgsfield.ai/pricing)
 * and reports video endpoints PortOS has no curated family for. Dependency-free.
 * Only names what exists: each family still needs its schema read from the
 * console model page and added to `higgsfieldVideoModels.js` before it can render.
 */

// Server-rendered state tags every object with `$R[n]=`; drop them so plain patterns match.
const stripRefs = (html) => String(html ?? '').replace(/\$R\[\d+\]=/g, '');

/** Every video endpoint the page lists: slug, title, resolutions, length range, from-price per second. */
export function parseHiggsfieldCatalog(html) {
  const text = stripRefs(html);
  const entries = new Map();
  const heads = [...text.matchAll(/slug:"([^"]+)",model_slug:"[^"]*",title:"([^"]*)"/g)];
  for (const [i, match] of heads.entries()) {
    const [, slug, title] = match;
    if (entries.has(slug)) continue;
    // Bounded at the next entry so a neighbour's fields never read as this one's.
    const body = text.slice(match.index, heads[i + 1]?.index ?? text.length);
    if (!/output_type:"video"/.test(body)) continue;
    const resolutions = /resolutions:\[([^\]]*)\]/.exec(body)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) || [];
    const [minSec, maxSec] = (/durations_seconds:\[([^\]]*)\]/.exec(body)?.[1].match(/\d+/g) || []).map(Number);
    const price = /pricing:\{primary:\{amount:"([\d.]+)"/.exec(body)?.[1];
    entries.set(slug, {
      slug, title, resolutions,
      minSec: minSec ?? null, maxSec: maxSec ?? null,
      pricePerSec: price ? Number(price) : null,
    });
  }
  return [...entries.values()];
}

/**
 * Group the endpoints PortOS does not offer into families (`kling-video/v4.0` →
 * its remaining routes), so "a whole new model" reads differently from "one more
 * route of a family we already have".
 */
export function findUnsupportedHiggsfieldFamilies(entries, supportedEndpoints) {
  const supported = new Set(supportedEndpoints);
  const byFamily = Map.groupBy(entries.filter((e) => !supported.has(e.slug)), (e) => e.slug.slice(0, e.slug.lastIndexOf('/')));
  const present = (rows, key) => rows.map((r) => r[key]).filter((v) => v != null);
  const bound = (pick, values) => (values.length ? pick(...values) : null);
  return [...byFamily].map(([family, rows]) => ({
    family,
    title: rows[0].title,
    routes: rows.map((r) => r.slug.slice(r.slug.lastIndexOf('/') + 1)),
    resolutions: [...new Set(rows.flatMap((r) => r.resolutions))],
    minSec: bound(Math.min, present(rows, 'minSec')),
    maxSec: bound(Math.max, present(rows, 'maxSec')),
    pricePerSec: bound(Math.min, present(rows, 'pricePerSec')),
  })).sort((x, y) => x.title.localeCompare(y.title));
}
