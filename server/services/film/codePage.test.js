import { expect, it } from 'vitest';
import { filmCodePage } from './codePage.js';

it("hands the module the song's own text, including replacement patterns", () => {
  const song = { title: "Ca$$h $& $' $`", lines: ['</script>'] };
  const html = filmCodePage({ entry: 'shots/a.js', song, width: 320, height: 180 });

  const json = html.match(/const specSong = (.*);\n/)[1];
  expect(JSON.parse(json)).toEqual(song);
  expect(json).not.toContain('</script>');
  expect(html).toContain('const entry = "./shots/a.js";');
});
