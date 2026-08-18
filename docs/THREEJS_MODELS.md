# Three.js Models

The Create → Three.js Models workspace turns one generated-gallery PNG into a
procedural Three.js scene with:

- an explicit AI provider/model choice per generation or refinement;
- a validated, bounded JSON scene spec rather than model-authored executable
  JavaScript;
- a live in-browser orbit/zoom preview using PortOS's existing Three.js stack,
  with explode-to-disassemble, click-to-identify part picking, and a timeline
  for any animation clips the spec declares;
- deterministic download/copy of a standalone `THREE.Group` factory, with a
  clip player over the same data;
- gallery-image lineage, run attribution, detail inventory, and honest
  single-view limitations.

## Why this is native instead of an `img2threejs` dependency

[hoainho/img2threejs](https://github.com/hoainho/img2threejs) is an Apache-2.0
agent skill and staged workflow, not an npm runtime or hosted image-to-mesh API.
PortOS reimplements the useful product contract—detail-first inspection,
procedural construction, animation-ready hierarchy, and refinement—on top of
its own provider runner and existing Three.js dependencies. No upstream scripts
or package are installed or executed.

## Trust boundary

Providers return only the declarative `threejsSculptSpecSchema` contract.
PortOS validates geometry sizes, hierarchy depth, material references, custom
triangle indices, sockets, and detail-inventory references before persisting or
rendering it. The client maps that allowlist to Three.js primitives and bounded
`BufferGeometry`; it never evaluates provider-written JavaScript. Exported
source is produced deterministically from the validated spec.

## Disassembly and part picking

The preview's Explode slider separates the assembly and clicking any surface
names the part it belongs to, highlighting that whole component. This is the
only *structural* check that a model was actually built from parts rather than
fused into one shape — every other check scores pixels.

Separation is a layout **scale about the model centre** plus a base clearance,
never a uniform outward push: displacing every part the same distance slides the
arrangement without opening a gap between neighbours, so parts that touched
would still touch. The camera re-frames to the disassembly's measured size.

Explode and the picker share one definition of "a part"
(`client/src/lib/threejsExplode.js`) — if they disagreed, both would be wrong:

- `explodeWithParent: true` marks **surface relief** — serrations, stria, trim,
  engraving, port floors: detail that belongs *to* a part rather than being one.
  It rides its parent when the model comes apart, and a click on it selects the
  parent, so a disassembly does not shatter into a comb of loose slivers.
  Generation prompts instruct the provider to set it; it defaults to `false`.
- Every other part carrying geometry is both a movable unit and a selectable
  component. A part whose children carry the geometry is additionally descended
  through, so those children separate too; a part with geometry *and*
  geometry-bearing children moves its own shell while its children move freely.

The exported standalone factory carries the same information —
`buildThreejsFactorySource()` writes `partId` and `explodeWithParent` into each
node's `userData` — so a consumer outside PortOS can build the same disassembly.

## Animation clips

A spec may declare an optional `animation` block: named **clips** (deploy,
retract, assemble, destroy, idle) built from named **sequences**, each carrying
one part from one authored endpoint to another inside a bounded time window.
Absent means the model is a static assembly — every spec written before clips
shipped keeps parsing, rendering, and exporting unchanged.

Clips are data, never code. A sequence names an easing (`linear`, `easeIn`,
`easeOut`, `easeInOut`) rather than supplying a curve, and drives only
`position`, `rotationDegrees`, `scale`, `opacity`, and `visible`. Materials,
lights, the camera, and geometry parameters are not animatable, so playback can
never change what the model *is*. Nothing is skinned: this is declared motion
over the existing part hierarchy, not a skeleton or a bind pose.

The schema rejects the ways a clip can be meaningless rather than letting the
runtime paper over them: a window that ends before it starts or outruns its
clip, a sequence whose endpoints are equal, two sequences driving one part's
channel at overlapping times, a sequence pointed at a part that does not exist,
and an unknown easing. `visible` is a **step**, not a fade — the part holds
`from` for the whole window and takes `to` the instant the sequence ends — so a
part that should appear mid-clip is authored as its own short sequence ending at
that moment.

Evaluation is a pure function of (clip, time) in
`client/src/lib/threejsAnimation.js`: each part+channel resolves from the one
sequence that owns the instant — the window containing it, else the most recent
window behind it (whose `to` still holds), else the next window ahead. So
scrubbing, playing, and a test all produce the same pose, and a part no sequence
drives renders exactly as authored.

### Sound cues

A sequence may name a `cueId` pointing at an entry in `animation.cues` — an
identifier and a kind (`latch`, `servo`, `hydraulic`, …), never a filename, a
URL, or audio data. PortOS ships no audio and plays none; the preview forwards
crossed cues to an optional `onCue` callback so a host can map them to its own
sounds. **Playback fires cues; scrubbing never does** — that split is the entire
reason a cue is data rather than embedded audio. A cue may only ride a sequence
that changes position, rotation, or scale: a sound needs movement to
synchronize to, and the schema rejects one attached to a fade.

### The playback gate

The schema proves a clip is well *formed*; `summarizeThreejsAnimation()`
(`server/lib/threejsModelAnimation.js`) reports the ways a well-formed clip
still plays badly, as advisory `warning` findings stored on the record beside
the clip inventory:

- **`clip-start-pose-mismatch`** — the first sequence on a part+channel starts
  from a pose the assembly does not build, so the model jumps the instant the
  clip opens.
- **`clip-sequence-jump`** — a following sequence starts somewhere other than
  where the previous one on that channel ended.
- **`loop-does-not-close`** — a `loop: true` clip whose end pose differs from
  its start pose, so it snaps on every repeat.
- **`idle-clip-does-not-loop`** — a role `idle` clip authored as a one-shot.
- **`unfired-cue`** — a declared cue no sequence fires.
- **`clip-holds-still`** — motion finishes in the first half of the window with
  more than 1.5s of dead tail left.
- **`articulation-without-clips`** — a spec with a real articulation graph (2+
  joints) and no `animation` at all. Deliberately narrow: a static object
  declares no joints and gets no finding, so nothing pushes every model toward
  motion it never showed.

Nothing here rejects a generation — a static assembly is a complete answer and
a stylized clip is the author's to keep. `buildThreejsAnimationFeedback()` turns
the findings into refinement feedback, so a refinement the user did not steer
asks for clips that open from the assembled pose and close their loops alongside
the coverage, cross-section, penetration, and material asks.

### The exported player

The exported standalone factory carries the validated `animation` block in
`userData.sculptRuntime` alongside the node map, plus a player over both:

```js
import { createExampleCrateModel, createSculptAnimationPlayer } from './example-crate.js';

const root = createExampleCrateModel();
const player = createSculptAnimationPlayer(root, { onCue: (event) => playMySound(event.cue) });
player.setClip('deploy');
player.play();
// from your own render loop:
player.update(deltaSeconds);
```

The player takes `update(deltaSeconds)` from the host's existing render loop
rather than owning a `requestAnimationFrame` loop, so it cannot keep ticking
after the consumer stops using it. `seek()` scrubs silently and `update()` is
the only thing that fires cues — the same split the preview makes. `restore()`
puts the authored assembly back, and a model with no clips yields a working
no-op player (`clips: []`), so a static assembly needs no branch at the call
site.

Its source is a fixed string (`server/lib/threejsModelPlayerSource.js`) spliced
into the emitted module: still no provider-authored code on the export path,
only PortOS code over provider-authored data. Its pose semantics mirror
`client/src/lib/threejsAnimation.js` exactly, so a clip poses identically in the
preview and in a consumer's own scene — change one and change the other.

## Geometry vocabulary

Alongside the primitives (box, sphere, cylinder, cone, torus, capsule, lathe)
and the bounded `custom` triangle mesh, the schema carries two constructive
forms so silhouette-defining shapes don't have to degrade into a coarse mesh:

- `extrude` — a closed 2D outline (3–160 points) with optional hole rings,
  swept to `depth` with optional bevel. Every ring must enclose real area and
  be simple (a self-crossing ring has no defined interior, and its lobes partly
  cancel so the area test alone does not catch it); each hole must lie strictly
  inside the outline (point-in-polygon on every vertex
  plus an edge sweep, since a concave outline's bounding box covers empty space
  its notch does not); and holes may not touch, cross, or nest. Each of those
  cases triangulates into an empty face, a disjoint face, or solid material
  inside a requested cutout rather than failing, so they are rejected up front.
- `tube` — a round profile of `radius` swept along a 2–96 point Catmull-Rom
  path. Consecutive points must differ and a `closed` path must not repeat its
  first point, because either produces NaN frames in the centripetal/chordal
  parameterizations. A `closed` path also needs three non-collinear points —
  fewer, or a straight line, closes into a curve that runs out and retraces
  itself, overlapping the tube with its own surface.

`type: "physical"` materials additionally carry bounded `ior`, `transmission`,
`thickness`, `sheen`, `iridescence`, and `anisotropy` for glass, cloth,
pearlescent, and brushed-metal finishes. Those channels are parsed for every
material type so a spec round-trips unchanged, but only forwarded to Three.js
for physical materials. `client/src/lib/threejsSculpt.js` mirrors the geometry
and material construction the exported factory emits, so the preview and the
downloaded source render the same scene.

## Provider behavior

API providers receive the gallery image as a multimodal image attachment. CLI
and TUI providers receive the gallery file path in the prompt so agents with
native image inspection can read it. A chosen provider/model still needs image
understanding; a text-only model will fail validation or produce a poor
reconstruction and can be replaced from the refinement controls.

Generation is always an explicit user action. Startup only marks a previously
in-flight run as interrupted and retryable; it never calls a provider.
