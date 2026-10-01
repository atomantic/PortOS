# Code Animation packages

Completed animations offer **Download package** beside Download HTML. The JSON
contains the exact saved HTML, its brief and frame settings, and integrity hashes.
It is a portable handoff to an external authoring harness. The existing preview
and MP4 export continue to use the saved job.

`GET /api/code-animation/:id/package` downloads a version-1 package. The job must
be completed; missing jobs return 404 and unfinished jobs return 409. A source
above the 2 MiB per-file package limit returns 422; Download HTML remains available. Local
provider ids, universe/mood-board pointers, upload URLs, reference attachments,
and prompt text are excluded. Source and artist-authored brief text are included;
review those before sharing a package. Selected external audio is declared but
its bytes are not included. Procedural Web Audio is declared as live sound with
no offline soundtrack. Unrecorded seed and execution settings remain `null`.

`POST /api/code-animation/packages/validate` accepts the package directly as its
JSON body. It returns `{ schemaVersion, revisionHash, renderer, fileCount,
totalBytes, executed: false }` or a 400 validation error. This is an integrity
check: it does not stage or execute code, install dependencies, call a provider,
create a project, or modify a saved animation. A valid Blender package does not
establish Blender readiness, code safety, a rendered result, or passing review.
Durable production import, execution, and rendering are separate implementation
slices of #9383.

## Version-1 envelope

All fields below are required. Unknown fields and unsupported versions are
rejected. There are no silent defaults during validation.

| Field | Contract |
|---|---|
| `schemaVersion` | Integer `1` |
| `manifest.title` | At most 200 characters |
| `manifest.brief` | `concept` (6,000 characters), `cast` (4,000), `onScreenText` (4,000) |
| `manifest.styleGuide` | At most 16,000 characters; empty is permitted |
| `manifest.renderer` | `kind`: `browser` or `blender`; nonempty `version` (128 characters); `engine`: string (128 characters) or `null`. Describes the renderer; never selects a host executable. Legacy exports use `code-animation-html-v1`, a runtime contract version. |
| `manifest.format` | Even `width`/`height` from 2 to 8,192; integer `fps` from 1 to 60; positive `durationSeconds` up to 180 |
| `manifest.seed` | Unsigned 32-bit integer or `null` |
| `manifest.entrypoints` | One to three `{ role, path }` entries; roles `scene`, `preview`, `render` are unique. Every path names a bundled file. Source language is renderer-specific. |
| `manifest.assets` | Up to 64 bundled file paths |
| `manifest.shots` | Up to 128 `{ label, startSeconds, endSeconds }` entries; positive intervals within the film |
| `manifest.events` | Up to 512 `{ label, atSeconds }` entries within the film. Shot/event labels have a 200-character limit. |
| `manifest.audio` | `{ kind: 'silence' }`, `{ kind: 'procedural', notes }`, `{ kind: 'external', notes }`, or `{ kind: 'file', path }`. Notes have a 1,500-character limit; file audio must be bundled. |
| `manifest.execution` | `requested` and `effective`, each `null` or `{ harness, connection, mode, model, effort }`. Strings are bounded (128 characters, model 256); unknown values remain `null`; mode is `api`, `cli`, or `tui`; effort uses the shared provider ladder. Imported metadata is a claim, never verified execution evidence. |
| `files` | One to 64 `{ path, encoding, content, sha256 }` entries. Encoding is `utf8` or canonical padded `base64`; SHA-256 is lowercase hex of decoded bytes. |
| `revisionHash` | Lowercase SHA-256 binding manifest, version, paths and file digests |

Paths are at most 240 characters, relative, slash-separated, and contain only
ASCII letters, digits, `.`, `_`, and `-`. Each segment starts with a letter or
digit and cannot end in a dot. Empty segments, dot segments, hidden paths,
absolute paths, backslashes, drive/URL prefixes, escaped separators and Windows
device names are refused. Duplicate paths, case collisions, and file/parent
collisions are refused on every platform. References must match the exact path.

Each decoded file is limited to 2 MiB and all decoded files together to 8 MiB.
Malformed or noncanonical base64 and invalid UTF-8 text are refused. File bytes
are checked against their digest before the validation can succeed.

The revision hash is SHA-256 over UTF-8 canonical JSON for:

```js
{
  schemaVersion,
  manifest,
  files: files.map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
```

Canonical JSON sorts object keys recursively, uses compact JSON serialization,
and preserves array order. The same bytes encoded as UTF-8 or base64 and the
same metadata in another key order retain the revision hash. File order does
not matter; timing/entrypoint/asset order does. Changing source bytes or manifest
settings changes the revision hash. The leaf contract in
`server/lib/codeAnimationPackage.js` provides the shared schema and builder.
No package is persisted by these endpoints, so this slice needs no new store,
seed, migration, or federation channel.

## Saved authoring settings

Production projects use the existing scoped provider/model/effort picker. These
settings remain machine-local and independent of the renderer and production
budgets. Save edits before using **Check saved authoring settings**.

`GET /api/code-animation/projects/:id/preflight` reads the saved selection and
reports missing/disabled routes, model pins, unsupported effort, and stale
connection/mode constraints. `resolved` is a configuration preview; `effective`
is null and `executed` is false. It neither contacts a model nor probes or grants
tools. Catalog compatibility does not verify runtime installation, credentials,
model access at the vendor, or render readiness. Production authoring dispatch,
render/inspection/research adapters, fallback decisions and actual-run provenance
remain pending under #9387 and the execution slices of #9383. Package export and
import remain available for external authoring.
