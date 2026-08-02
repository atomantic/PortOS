/**
 * Prompt contract for image → declarative procedural Three.js generation.
 *
 * Inspired by img2threejs's detail-inventory and animation-ready hierarchy
 * approach, while targeting PortOS's bounded JSON scene schema.
 */

const geometryContract = `
Allowed geometry definitions:
- {"type":"box","width":n,"height":n,"depth":n}
- {"type":"sphere","radius":n,"widthSegments":8..96,"heightSegments":4..64}
- {"type":"cylinder","radiusTop":n,"radiusBottom":n,"height":n,"radialSegments":3..96}
- {"type":"cone","radius":n,"height":n,"radialSegments":3..96}
- {"type":"torus","radius":n,"tube":n,"radialSegments":3..64,"tubularSegments":6..128,"arcDegrees":1..360}
- {"type":"capsule","radius":n,"length":n,"capSegments":2..32,"radialSegments":3..64}
- {"type":"lathe","points":[[x,y],...],"segments":3..96}
- {"type":"extrude","outline":[[x,y],...],"holes":[[[x,y],...],...],"depth":n,"bevelEnabled":false,"bevelThickness":n,"bevelSize":n,"bevelSegments":0..8,"curveSegments":1..24,"steps":1..32} (a closed 2D outline of 3..160 points swept along +Z; \`holes\` are closed rings cut out of it. Every ring must enclose real area and every hole must lie inside the outline.)
- {"type":"tube","path":[[x,y,z],...],"radius":n,"tubularSegments":2..256,"radialSegments":3..32,"closed":false,"curveType":"centripetal"|"chordal"|"catmullrom","tension":0..1} (a round profile swept along a smooth 2..96 point curve. Consecutive path points must differ, and a closed path must not repeat its first point at the end.)
- {"type":"custom","vertices":[x,y,z,...],"indices":[a,b,c,...]} (triangle mesh; use only when primitives cannot express an identity-defining silhouette)

Choosing between them:
- extrude — flat or plate-like parts whose identity is their silhouette: badges, logos, letters, signs, panels with cutouts, keyholes, vents, window frames, gears, brackets, star/cross/gem profiles.
- tube — anything sweeping a constant round section along a path: cables, hoses, wires, handles, pipes, straps, springs, antennae, bent rods, rope, rims.
- lathe — profiles that are rotationally symmetric about the Y axis.
- custom triangles — a last resort, only after none of the above can express the silhouette.
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
    "position":[x,y,z],"rotationDegrees":[x,y,z],"scale":[x,y,z],
    "castShadow":true,"receiveShadow":true,
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
`;

export function buildThreejsGenerationPrompt({
  sourcePath,
  name,
  prompt = '',
  currentSpec = null,
  feedback = '',
}) {
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
${refinement}
WORKFLOW:
1. Inspect the image before deciding geometry.
2. Classify the subject as object, character, or hybrid.
3. Inventory every identity-defining visible detail: silhouette, proportions, bevels/rounding, seams, trim, controls, fasteners, facial landmarks, limbs, wear, gloss, emissive regions, and attachment points.
4. Build from a clear parent/child hierarchy. Put moving or attachable pieces in their own named parts. Add sockets for meaningful pivots/attachments.
5. Use primitive composition first, then the schema-backed extrude/tube/lathe forms for silhouettes, cutouts, and swept details. Use custom triangles only when no other allowed form can reproduce the shape.
6. Use physically coherent PBR material channels. Reach for "physical" with ior/transmission/thickness for glass, gems, liquid, and clear plastic, sheen for cloth and velvet, iridescence for oil-slick/soap-film/pearlescent finishes, and anisotropy for brushed metal or spun discs. Do not use textures, external meshes, URLs, downloaded assets, or JavaScript.
7. Center the subject near the origin, keep dimensions internally consistent, and choose a camera that frames the whole model.
8. Be honest about unseen sides in limitations. Infer conservatively; never claim exact hidden geometry.
9. Ensure every detailInventory item points to real part ids, every material reference exists, every socket parent exists, all ids are unique, custom indices are in range, extrude rings enclose real area with holes inside the outline, and tube paths never repeat a point.

QUALITY GATE:
- A compound subject must not collapse into one primitive.
- Major visible attachments may not float or be omitted.
- Identity-priority details must be represented by actual geometry/material choices.
- Do not spend custom triangles on a shape extrude, tube, or lathe already expresses.
- Include useful ambient/hemisphere fill plus at least one directional/key light.
- Keep the full hierarchy at 160 parts or fewer.

${geometryContract}
${outputContract}`;
}
