/**
 * Prompt contract for image → declarative procedural Three.js generation.
 *
 * Inspired by img2threejs's detail-inventory and animation-ready hierarchy
 * approach, while targeting PortOS's bounded JSON scene schema.
 */

import { buildThreejsFamilyChecklist } from '../../lib/threejsModelFamilies.js';

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

Every part "scale" component (sx, sy, sz) must be a strictly positive size multiplier of
at least 0.0001. Zero collapses the part to an invisible plane and a negative component
reflects it; both are rejected. This format has no reflection and no hidden parts — build
a mirrored counterpart as its own part with its own position and rotationDegrees, and
simply omit a part you do not want rendered.
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

  return `You are a senior procedural 3D artist reconstructing one reference image as an animation-ready Three.js model.

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
6. Use physically coherent PBR material channels. Reach for "physical" with ior/transmission/thickness for glass, gems, liquid, and clear plastic, sheen for cloth and velvet, iridescence for oil-slick/soap-film/pearlescent finishes, and anisotropy for brushed metal or spun discs. Do not use textures, external meshes, URLs, downloaded assets, or JavaScript.
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
- Keep the full hierarchy at 160 parts or fewer.${familyChecklist ? `
- Every required component in the subject-family checklist is either built and inventoried, or
  named in limitations with the reason the reference does not support it. Silence on one is a failure.
- The checklist is the floor: a spec that inventories only the checklist and nothing else has
  under-observed the reference.` : ''}

${geometryContract}
${outputContract}`;
}
