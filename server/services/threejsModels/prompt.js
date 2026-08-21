/**
 * Prompt contract for image → declarative procedural Three.js generation.
 *
 * Inspired by img2threejs's detail-inventory and animation-ready hierarchy
 * approach, while targeting PortOS's bounded JSON scene schema.
 */

import {
  buildThreejsFamilyChecklist,
  GENERAL_FAMILY_ID,
  THREEJS_MODEL_FAMILY_IDS,
} from '../../lib/threejsModelFamilies.js';

const geometryContract = `
Allowed geometry definitions:
- {"type":"box","width":n,"height":n,"depth":n}
- {"type":"sphere","radius":n,"widthSegments":8..96,"heightSegments":4..64}
- {"type":"cylinder","radiusTop":n,"radiusBottom":n,"height":n,"radialSegments":3..96}
- {"type":"cone","radius":n,"height":n,"radialSegments":3..96}
- {"type":"torus","radius":n,"tube":n,"radialSegments":3..64,"tubularSegments":6..128,"arcDegrees":1..360}
- {"type":"capsule","radius":n,"length":n,"capSegments":2..32,"radialSegments":3..64}
- {"type":"lathe","points":[[x,y],...],"segments":3..96}
- {"type":"extrude","outline":[[x,y],...],"holes":[[[x,y],...],...],"depth":n,"bevelEnabled":false,"bevelThickness":n,"bevelSize":n,"bevelSegments":0..8,"curveSegments":1..24,"steps":1..32} (a closed 2D outline of 3..160 points swept along +Z; \`holes\` are closed rings cut out of it. Every ring must enclose real area and must not cross itself, every hole must lie strictly inside the outline, and holes must not touch, overlap, or nest inside each other.)
- {"type":"tube","path":[[x,y,z],...],"radius":n,"tubularSegments":2..256,"radialSegments":3..32,"closed":false,"curveType":"centripetal"|"chordal"|"catmullrom","tension":0..1} (a round profile swept along a smooth 2..96 point curve. Consecutive path points must differ; a closed path must not repeat its first point at the end and needs at least three non-collinear points.)
- {"type":"custom","vertices":[x,y,z,...],"indices":[a,b,c,...]} (triangle mesh; use only when primitives cannot express an identity-defining silhouette)

Choosing between them:
- extrude — flat or plate-like parts whose identity is their silhouette: badges, logos, letters, signs, panels with cutouts, keyholes, vents, window frames, gears, brackets, star/cross/gem profiles.
- tube — anything sweeping a constant round section along a path: cables, hoses, wires, handles, pipes, straps, springs, antennae, bent rods, rope, rims.
- lathe — profiles that are rotationally symmetric about the Y axis.
- custom triangles — a last resort, only after none of the above can express the silhouette.

A genuinely zero-thickness two-sided surface — such as a wing membrane, cape, leaf, or fin —
needs a material with "side":"double" or it disappears from behind. Use that declaration only
for an intentional open shell; it must not be used to dodge giving a solid part a real cross-section.

When extrude is the WRONG answer: an unbevelled extrude has exactly two depth planes, so it is
a slab. A body with a real cross-section — a torso, a limb, a head, a housing, a grip, a shell
that swells or tapers through its thickness — must not be one. Build it from primitives, a
lathe, or a tube, or compose several. When only an extrude can express the silhouette of a part
that is not genuinely plate-like, set "bevelEnabled":true with a real bevelThickness/bevelSize,
or add primitives on top of it that give it depth. The same applies to custom triangles: a fan
of points sharing one Z value is a cut-out no matter how many triangles it carries — a custom
mesh standing in for a solid must have depth on every axis.
`;

const outputContract = `
Return one raw JSON object and nothing else. It must have exactly this top-level shape:
{
  "schemaVersion": 1,
  "name": "Short model name",
  "summary": "What was reconstructed and the main modeling decisions",
  "subjectType": "object" | "character" | "hybrid",
  "limitations": ["Honest uncertainty about hidden or ambiguous regions"],
  "background": "#RRGGBB",
  "camera": {"position":[x,y,z],"target":[x,y,z],"fov":42},
  "materials": {
    "materialId": {
      "type":"standard" | "physical" | "basic",
      "side":"front" | "double",
      "color":"#RRGGBB","metalness":0..1,"roughness":0..1,
      "emissive":"#RRGGBB","emissiveIntensity":0..20,
      "opacity":0..1,"transparent":false,"wireframe":false,
      "clearcoat":0..1,"clearcoatRoughness":0..1,
      "ior":1..2.333,"transmission":0..1,"thickness":n,
      "sheen":0..1,"iridescence":0..1,"anisotropy":0..1
    }
  },
  "lights": [{
    "type":"ambient" | "hemisphere" | "directional" | "point" | "spot",
    "color":"#RRGGBB","groundColor":"#RRGGBB","intensity":n,
    "position":[x,y,z],"angleDegrees":45,"penumbra":0.25
  }],
  "environment": {"preset":"none" | "neutral" | "studio","intensity":0..4},
  "parts": [{
    "id":"stablePartId","name":"Readable part name",
    "geometry": { ...one allowed geometry... },
    "material":"materialId",
    "position":[x,y,z],"rotationDegrees":[x,y,z],"scale":[sx,sy,sz],
    "castShadow":true,"receiveShadow":true,
    "explodeWithParent":false,
    "children":[ ...same part shape... ]
  }],
  "sockets": [{"name":"socketName","parentPartId":"partId","position":[x,y,z],"rotationDegrees":[x,y,z]}],
  "detailInventory": [{
    "feature":"Visible identity-defining detail",
    "evidence":"Where/how it appears in the reference",
    "implementationPartIds":["partId"],
    "priority":"identity" | "major" | "minor"
  }]
}

"environment" is the image-based lighting the scene is composed against, and it is what the
reflective channels actually read: "metalness", "transmission", "clearcoat" and "iridescence"
reflect an environment or they reflect nothing, so a physically correct metal in a scene with
"preset":"none" renders near-black however right its values are. "lights" alone cannot supply
it. Choose "studio" for anything with bare metal, chrome, gloss, glass or gems — it is a dark
room with bright softboxes, which gives a conductor high-contrast highlights. Choose "neutral"
for an evenly-lit subject in matte materials. Choose "none" only for a deliberately flat,
unreflective look. "intensity" scales how strongly surfaces pick it up; 1 is the neutral value.

Every part "scale" component (sx, sy, sz) must be a strictly positive size multiplier of
at least 0.0001. Zero collapses the part to an invisible plane and a negative component
reflects it; both are rejected. This format has no reflection and no hidden parts — build
a mirrored counterpart as its own part with its own position and rotationDegrees, and
simply omit a part you do not want rendered.

A part's scale applies to its whole group and cascades to everything nested under it. Keep a
container part that owns other components near-uniformly scaled; author a part's proportions
through its own geometry dimensions (box width/height/depth, sphere radius, and equivalent
dimensions on other geometries) instead of using a non-uniform parent scale to shape its
children.
`;

const CHARACTER_FAMILY_ID = 'character';
// Positive list, not "anything but object": the contract is requested for the
// classifications it is written for, so a spec carrying a subjectType this build
// does not know (a newer peer, a hand-repaired record, a later enum) falls back
// to the family signal instead of silently qualifying as a character.
const ARTICULATED_SUBJECT_TYPES = new Set(['character', 'hybrid']);

// Requested ONLY when the subject could be a character. A chosen vehicle,
// weapon, architecture, or device family is positive evidence that it is not,
// and a refinement pass over a spec the model already classified as an `object`
// is the same evidence — those prompts stay exactly as they were. An unknown
// family id resolves to `general` the way the checklist builder resolves it, so
// a stale stored family cannot silently change which contract is requested.
const wantsArticulation = (family, currentSpec) => {
  // A spec that has already been classified answers the question by itself; the
  // family is only a guess about a subject nobody has looked at yet.
  if (currentSpec?.subjectType) return ARTICULATED_SUBJECT_TYPES.has(currentSpec.subjectType);
  const resolved = THREEJS_MODEL_FAMILY_IDS.includes(family) ? family : GENERAL_FAMILY_ID;
  return resolved === CHARACTER_FAMILY_ID || resolved === GENERAL_FAMILY_ID;
};

// PortOS does not skin, bind, or deform anything — this asks for a DECLARATION
// of what is meant to move, so a later rig/export path has stable ids to attach
// to and the workspace can report rig readiness truthfully instead of calling
// every parts hierarchy animation-ready.
const articulationContract = `
ARTICULATION (character and hybrid subjects only):
If — and only if — you classify the subject as "character" or "hybrid", also return an
"articulation" object alongside "sockets". Omit the key entirely for an "object" subject,
and omit it for a character whose reference does not support a defensible joint layout.

"articulation": {
  "joints": [{"id":"stableJointId","partId":"partId","parentJointId":null,"pivotSocket":"socketName"}],
  "attachments": [{"partId":"partId","anchorPartId":"partId","maxOffset":0.25}]
}

Rules, all enforced — a spec that breaks one is rejected outright:
- Exactly ONE joint has "parentJointId": null. That is the root.
- Every other joint's "parentJointId" names a joint declared EARLIER in the array, so the
  graph reads root-first and cannot contain a cycle or a forward reference.
- Every "partId" names a real part, and no part is driven by two joints.
- "pivotSocket" names a real entry in "sockets" — the point the part rotates about. Add that
  socket. The root may use null; every other joint needs one to be considered rig-ready.
- "attachments" lists parts that are CARRIED rather than articulated (packs, weapons, hats,
  held props). A part may be an attachment or be driven by a joint, never both.
- EVERY attachment must name what it hangs from: exactly one of "anchorPartId" (a real part)
  or "anchorSocket" (a real entry in "sockets"). An attachment is only meaningful relative to
  its anchor, and one that names nothing is reported as unanchored rather than accepted.
- The anchor must be the body part or socket that actually carries the piece — a hat is
  anchored to the head, a charm to the staff it hangs from. The MODEL ROOT is not an
  acceptable anchor: it carries no relationship to any body part, which is exactly how a hat
  ends up rendered at hip height. An anchor may not be the attachment itself, and anchor
  chains may not cycle.
- Position each attachment ON its anchor. "maxOffset" (default 0.25, world units) is how far
  the attachment's bounds may sit from the anchor's surface before the physical audit calls
  the relationship broken; raise it only for a piece that genuinely hangs at a distance.

This is an intent declaration, not a skeleton: do not invent skinning weights, a bind pose, or
bones for parts the reference does not clearly show. A short, defensible graph beats a long
speculative one, and omitting the key is better than guessing.
`;

// Clips are DATA, not code: named windows over parts the spec already builds,
// with an easing NAME rather than a curve, so PortOS can scrub them
// deterministically and never has to run anything the provider wrote. The block
// is offered for every subject — a deployable can be an object, a character, or
// a hybrid — but the default answer is silence: an assembly with no mechanism
// the reference actually shows is a static model, and inventing motion for it is
// worse than omitting the key.
const animationContract = `
ANIMATION CLIPS (optional, any subject):
Return an "animation" object ONLY if the reference clearly shows a mechanism that deploys,
retracts, opens, folds, spins, or comes apart. Omit the key entirely for a static subject —
a static assembly is a complete answer, and invented motion is not.

"animation": {
  "clips": [{
    "id":"deploy","name":"Deploy","role":"deploy"|"retract"|"assemble"|"destroy"|"idle"|"custom",
    "durationSeconds":0.05..120,"loop":false,
    "sequences": [{
      "id":"stableSequenceId","name":"Readable step name","partId":"partId",
      "startSeconds":n,"endSeconds":n,
      "easing":"linear"|"easeIn"|"easeOut"|"easeInOut",
      "channels": {
        "position":{"from":[x,y,z],"to":[x,y,z]},
        "rotationDegrees":{"from":[x,y,z],"to":[x,y,z]},
        "scale":{"from":[sx,sy,sz],"to":[sx,sy,sz]},
        "opacity":{"from":0..1,"to":0..1},
        "visible":{"from":true,"to":false}
      },
      "cueId":"cueId"
    }]
  }],
  "cues": [{"id":"cueId","label":"What is heard","kind":"mechanical"|"servo"|"latch"|"hydraulic"|"impact"|"electronic"|"ambient"}]
}

Rules, all enforced — a spec that breaks one is rejected outright:
- Every "partId" names a real part. A sequence moves that part and everything parented to it.
- "endSeconds" is strictly greater than "startSeconds", and no sequence ends after its clip's
  "durationSeconds". A clip may hold its final pose after the last sequence finishes.
- Every sequence changes at least one channel: a "from" equal to its "to" moves nothing.
- Two sequences may not drive the same channel of the same part at overlapping times. Chain them
  end-to-start instead, and start the next one from where the previous one ended so the part does
  not jump.
- "visible" is a step, not a fade: the part holds "from" for the whole window and takes "to" the
  instant the sequence ends. To make a part appear part-way through, give it its own short
  sequence ending at that moment.
- Every "cueId" names an entry in "cues", and a cue may only ride a sequence that changes
  position, rotationDegrees, or scale — a sound has to have movement to synchronize to. Cues are
  identifiers only: never a filename, a URL, or audio data. PortOS plays no sound for them.
- Channels are the only animation surface. Do not animate materials, lights, the camera, or
  geometry parameters, and do not return JavaScript, keyframe arrays, or curve definitions.

Also checked after generation, and fed back as refinement notes rather than rejected:
- A "loop": true clip returns to where it began — its last endpoint on a channel equals that
  channel's first one — or it snaps back on every repeat. An "idle" clip is repeating motion by
  definition, so give it "loop": true.
- Every declared cue is fired by at least one sequence; a cue nothing fires asks for a sound that
  never plays.
- "durationSeconds" ends near where the motion does. A short hold on the final pose is good; a
  clip that finishes in its first half and then sits still for seconds is a mistyped duration.

Prefer a short, legible set: a "deploy" clip and its "retract" mirror explain a mechanism better
than eight speculative ones. Author each clip against the model's assembled pose — sequence one
starts from exactly the "position"/"rotationDegrees"/"scale" the part carries in "parts".
`;

export function buildThreejsGenerationPrompt({
  sourcePath,
  name,
  prompt = '',
  currentSpec = null,
  feedback = '',
  family = null,
}) {
  // Empty for the default `general` family, so a user who does not narrow the
  // subject gets the same general-purpose prompt this contract always shipped.
  const familyChecklist = buildThreejsFamilyChecklist(family);
  const refinement = currentSpec
    ? `
This is a refinement pass. Preserve good existing work, but revise the scene spec to address the feedback.
CURRENT VALIDATED SPEC:
${JSON.stringify(currentSpec)}

REFINEMENT FEEDBACK:
${feedback || 'Improve likeness, proportions, construction, and visible detail.'}
`
    : '';

  // PortOS ships no skinning or skeletal-export path, so the brief no longer
  // calls the result "animation-ready" — what it asks for is a model that comes
  // apart cleanly, plus (for characters) an explicit declaration of what is
  // meant to move.
  const articulation = wantsArticulation(family, currentSpec) ? articulationContract : '';

  return `You are a senior procedural 3D artist reconstructing one reference image as a cleanly decomposed Three.js model.

REFERENCE IMAGE:
- A multimodal API provider receives the image as an attached image.
- A local/CLI/TUI agent can inspect the same image at: ${sourcePath}
- Target name: ${name}
- User direction: ${prompt || 'Faithfully reconstruct the main subject.'}
${refinement}${familyChecklist}
WORKFLOW:
1. Inspect the image before deciding geometry.
2. Classify the subject as object, character, or hybrid.
3. Inventory every identity-defining visible detail: silhouette, proportions, bevels/rounding, seams, trim, controls, fasteners, facial landmarks, limbs, wear, gloss, emissive regions, and attachment points.
4. Build from a clear parent/child hierarchy. Put moving or attachable pieces in their own named parts. Add sockets for meaningful pivots/attachments. Set "explodeWithParent":true on surface relief — serrations, stria, ridges, trim, engraving, port floors, panel lines and other detail that belongs TO a part rather than being a part — so the viewer takes the model apart into readable components instead of a comb of loose slivers. Leave it false (the default) on anything a person would call a separate component.
5. Use primitive composition first, then the schema-backed extrude/tube/lathe forms for silhouettes, cutouts, and swept details. Use custom triangles only when no other allowed form can reproduce the shape.
6. Use physically coherent PBR material channels. Reach for "physical" with ior/transmission/thickness for glass, gems, liquid, and clear plastic, sheen for cloth and velvet, iridescence for oil-slick/soap-film/pearlescent finishes, and anisotropy for brushed metal or spun discs. Then choose the "environment" preset those channels need — they read off it, not off "lights". Do not use textures, external meshes, URLs, downloaded assets, or JavaScript.
7. Center the subject near the origin, keep dimensions internally consistent, and choose a camera that frames the whole model.
8. Be honest about unseen sides in limitations. Infer conservatively; never claim exact hidden geometry.
9. Ensure every detailInventory item points to real part ids, every material reference exists, every socket parent exists, all ids are unique, custom indices are in range, extrude rings enclose real area with non-overlapping holes inside the outline, and tube paths never repeat a point.

QUALITY GATE:
- A compound subject must not collapse into one primitive.
- The model must come apart into readable components: every piece a person would name is its own part, and every detail that merely rides a surface carries "explodeWithParent":true.
- Major visible attachments may not float or be omitted.
- Identity-priority details must be represented by actual geometry/material choices.
- Do not spend custom triangles on a shape extrude, tube, or lathe already expresses.
- A subject that is not genuinely plate-like must not have every identity part flat along one axis: the model has to hold up when it is orbited, not only from the camera you choose.
- Include useful ambient/hemisphere fill plus at least one directional/key light.
- Any spec that authors a reflective channel — metalness above 0.6, or any transmission,
  clearcoat, or iridescence — sets an "environment" preset other than "none". Those values
  cannot be judged, by you or by anyone reviewing the render, in a scene with nothing to reflect.
- Keep the full hierarchy at 160 parts or fewer.${familyChecklist ? `
- Every required component in the subject-family checklist is either built and inventoried, or
  named in limitations with the reason the reference does not support it. Silence on one is a failure.
- The checklist is the floor: a spec that inventories only the checklist and nothing else has
  under-observed the reference.` : ''}

${geometryContract}
${outputContract}${articulation}${animationContract}`;
}
