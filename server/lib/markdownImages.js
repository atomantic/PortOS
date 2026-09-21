/** Bounded image projection for cards; accepts the same URL schemes as MarkdownOutput. */
export function markdownImages(content, limit = 4) {
  const images = [];
  const seen = new Set();
  for (const match of String(content || '').matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const [, alt, src] = match;
    if (!/^(https?:\/\/|\/[^/])/.test(src) || seen.has(src)) continue;
    seen.add(src);
    images.push({ src, alt });
    if (images.length >= limit) break;
  }
  return images;
}
