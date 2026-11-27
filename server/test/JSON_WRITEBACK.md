# JSON write-back prevention guard

Run from `server/`: `node_modules/.bin/vitest run test/guards/runtime.guard.test.js -t jsonWritebackConventions` (the check lives in `test/guards/runtime/jsonWritebackConventions.test.js`).
The guard parses source without importing services or reading runtime data.
A non-strict read paired with `atomicWrite` on the same path in a service
requires an entry in [jsonWritebackExceptions.js](jsonWritebackExceptions.js).
Explain why the fallback cannot overwrite durable data or cite a tracked
conversion. Remove stale entries when the pair disappears.

## Raw reads feeding `safeJSONParse` (#12440)

The scanner also tracks `tryReadFile` and `readFile` results that reach
`safeJSONParse` inline or through an in-scope variable. Text and hash reads
that never reach a parser are excluded. Use `tryReadFileStrict` or
`readJSONFileStrict` so only ENOENT initializes data and other failures
refuse write-back.

## Matching and maintenance

The scanner matches parsed calls by module and normalized first argument,
independent of line positions and formatting. It recognizes
one hop through recognized relative-import wrappers. Literal strict options
count only when later properties cannot override them. Review dynamic paths,
options and deeper wrappers at their call sites. Resolve stale exceptions when
their pair disappears, and prefer strict reads for new durable write-back paths.
