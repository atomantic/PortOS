/**
 * The sum of ffmpeg expression terms as a balanced tree. ffmpeg refuses an
 * expression nested about 100 levels deep, and a flat `a+b+c` nests one level per
 * term, so an expression built per shot or per beat fails at filter init on a long
 * edit. Browser-safe: the client re-exports modules that use it.
 */
export const sumExpr = (terms) => {
  if (terms.length < 3) return terms.join('+');
  const half = terms.length >> 1;
  return `(${sumExpr(terms.slice(0, half))})+(${sumExpr(terms.slice(half))})`;
};
