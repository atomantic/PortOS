# Historical starter preview compatibility

Approved scope against `36a72e0ad89b74c5ef275fa232bdc8f4bcd3fd32`: recognize
one untouched layered starter graph from
`907afda86741852df1e7c1fa49d61a5a9bb4d758`. Adapt only its disposable preview
copy. Do not upgrade immutable documents, final-render inputs, authored code,
templates, generators, browser policy or the playback clock.

## Exact graph

All hashes are SHA256 of raw file bytes. Historical index and helpers must
match together before any scratch write. A generated or customized entrypoint
and a mixed helper graph retain exact fallback. Inert unreferenced files remain
unchanged. No source-kind or filename heuristic establishes executable trust.

| Document path | Bytes | SHA256 |
| --- | ---: | --- |
| `engine.js` | 30112 | `9581bb2d190e62ea2eb6a709bc989b1f913c501236554cd0301379877dc8a5fc` |
| `index.html` | 1781 | `a5a384bf17ad9858bfe5ce0c960fd5c194ebfbf581d8f4994694df48bec09936` |
| `cameraRig.js` | 16149 | `508b9bbad6490903f53c0928fb24a62812caf17800ded5c7248bf7b7740b95a2` |
| `lyricType.js` | 22748 | `f2f2cc5094a6407226b5f5d62c6788ccc7220a8e13ad6b81415422d3efa3f961` |
| `lyricType.css` | 381 | `b48f2ac170e4c53cda88dc44d78a03e5862bc67e04b0244602e1a39098c0054c` |
| `fonts/big-shoulders-stencil-display-900.woff2` | 14196 | `d071c3ae576a9d0e149af9f8dea74a5cee7a403b53d543b2f4d984cd65ebcb8b` |
| `fonts/ibm-plex-mono-400.woff2` | 14708 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `fonts/ibm-plex-mono-600.woff2` | 15620 | `0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83` |
| `fonts/ibm-plex-sans-condensed-500.woff2` | 19952 | `e3b4fd97fd20bc70fda66d8d5f0745d8d6958068a024cb4724bbc1ffb6cbc183` |
| `fonts/ibm-plex-sans-condensed-700.woff2` | 19352 | `4768878c107d92c528a65bba206a87cdcf2c694514e75907fb91772cf8a388a5` |
| `fonts/archivo-variable.woff2` | 90104 | `e3a28eade21a900c7155a247757f4b2834c07bb7ef07ad7efa55cebaac1e8f5e` |
| `fonts/ibm-plex-mono-500.woff2` | 14888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |

The historical engine, index and lyric module differ from current. Camera rig,
CSS and seven fonts are currently byte-identical; their historical hashes still
apply if current assets change later. Preserve applicable source/font licenses.
Tests and runtime must not read Git history.

## Publication and compatibility invariants

The historical engine has the same closure seams as the current bridge. Change
only the two canvas/context bindings and append the common bridge after all
three insertion sites have been validated. Its exact seek method, from
`    async seek(t,` through the method's closing comma, is 318 bytes with hash
`c8ac135592ac2bf56736f227ef0cb6cc46d3cf68a37a2b1b775f265246cead34`.
It must remain byte-identical. This extraction ends at the first `\n    },`
after the method header, inclusive; it excludes the enclosing object close.

- Preserve the historical lyric module's timing, sizes, zones and repeated-hook
  behavior. Include nonempty timed lyrics in compatibility evidence.
- Preserve the engine's intentional absence of still-image effects, including
  when current staged scene data names an effect. Do not supply current effects
  or replace the historical lyric helper.
- Retain `retimed: true` staging and staged in/out mapping. Rate and lead have
  already been applied; do not add the newer raw-media timing path. Retimed 24 fps
  input does not establish 30 distinct source frames.
- Preserve source/card selection, camera, narrative holds, exact pause/export
  and song-time finishing. Retain the existing common bridge and deadlines.
- Present authored declarations retain priority, including unsupported or
  malformed declarations. They never fall through to historical adaptation.
- Retain trusted staged video cadence above 10 fps, verified Chromium capture
  support and request/cancel video-frame callbacks before advertising playback.
- Do not admit the other six historical adoption hashes, arbitrary helpers,
  generated functions or customized engines through this descriptor.

## Verification and later native admission

Focused filesystem/VM/public-opener tests must establish graph admission and
fallback, no writes on decline, unchanged source/exact bytes, historical lyric
rendering, ignored image effects, staged timing and declaration precedence.
Reuse current fonts/helpers in synthetic fixtures only after checking their
literal historical hashes. Retain historical source fixtures and licenses.

Native execution requires a separately reviewed fixture, source binding and
explicit owned-process/time budget. The primary cadence measurement retains
the original **three windows over 27 seconds**, on one continuous, unheld 30 fps
source and one playback epoch. Nonempty historical timed lyrics belong in this
primary interval; no narrative hold or scene change may divide it.

Old-versus-old native PNG and final parity checks for holds, still/card/source
selection, camera, ignored image effects and finishing use a separate correctness
phase or post-window tail. Account explicitly for its control worker, assets,
elapsed budget and cleanup. Do not silently extend an admitted run or reinterpret
held/static frames as cadence evidence. Preserve original native dimensions,
JPEG quality, actual decoded content IDs, audio bounds, window thresholds and
owned child/profile/scratch cleanup. State input dimensions and codec; no cold
handoff, high-resolution decoding or arbitrary-document performance claim follows.

Independent source and result review precede shipping. Generated contracts and
additional historical graphs remain separate scopes; issue #11221 stays open.
