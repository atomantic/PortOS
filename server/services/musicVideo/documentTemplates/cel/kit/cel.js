// The cel camera for drawn characters.
//
// A character's forms are flattened here with true depth, so the nearer form always covers the farther
// one (an arm never slides through a dress) and every overlap gets its contour. The result is still a
// cel: flat paint, one shadow tone with a clean edge, shadows cast from one form onto another, and an
// ink line wherever a silhouette, a colour boundary or a step in depth is seen.
//
// Three passes on one WebGL2 canvas: (1) a depth map from the light, for cast shadows; (2) the forms,
// drawn at twice the frame's resolution into "what colour, lit or shaded, how deep"; (3) the drawing:
// paint, 2D-drawn details (face, hair sheen, folds) laid onto the surfaces they belong to, and ink.

const VS_GEOM = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec3 aAttr;
uniform mat3 uV; uniform vec4 uScr; uniform vec2 uSize; uniform float uRange;
uniform mat3 uLV; uniform vec3 uLC; uniform float uLE;
out vec3 vNor; out vec3 vAttr; out vec3 vLight; out float vDepth; out float vFace;
void main() {
  vec3 v = uV * aPos;
  vFace = (uV * aNor).z;
  float x = uScr.y + uScr.x * v.x, y = uScr.z - uScr.x * v.y;
  float d = clamp((v.z - uScr.w) / uRange, -1.0, 1.0);
  gl_Position = vec4(2.0 * x / uSize.x - 1.0, 1.0 - 2.0 * y / uSize.y, -d, 1.0);
  vNor = aNor; vAttr = aAttr; vDepth = d * 0.5 + 0.5;
  vLight = (uLV * (aPos - uLC)) / uLE * 0.5 + 0.5;
}`;
const FS_GEOM = `#version 300 es
precision highp float;
in vec3 vNor; in vec3 vAttr; in vec3 vLight; in float vDepth; in float vFace;
uniform vec3 uL; uniform float uTerm; uniform float uBackDark[12]; uniform float uCastReach[12];
uniform highp sampler2D uShadow; uniform sampler2D uShadowMat; uniform float uShadowOn;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
void main() {
  vec3 n = normalize(vNor);
  bool back = vFace < 0.0;
  if (back) n = -n;
  int mat = int(vAttr.x + 0.5);
  float facing = dot(n, uL);
  float ndl = facing - uTerm - vAttr.z;
  float w = max(fwidth(ndl), 1e-4);
  float lit = smoothstep(-w, w, ndl);
  if (uShadowOn > 0.5 && lit > 0.0) {
    // Shadows are cast only from one material onto another (hair on the face, an arm on the dress).
    float own = 1.0 - vLight.z;
    float bias = 0.0016 + 0.01 * (1.0 - clamp(facing, 0.0, 1.0));
    float shade = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 off = vec2(float(i % 2) - 0.5, float(i / 2) - 0.5) / 2048.0;
      float sd = texture(uShadow, vLight.xy + off).r;
      float caster = texture(uShadowMat, vLight.xy + off).r * 255.0;
      if (own > sd + bias && own - sd < uCastReach[mat] && abs(caster - vAttr.x) > 0.5) shade += 0.25;
    }
    lit *= 1.0 - shade;
  }
  if (back && uBackDark[mat] > 0.5) lit = 0.0;
  o0 = vec4(vAttr.x / 255.0, lit, vAttr.y / 255.0, 1.0);
  float d16 = clamp(vDepth, 0.0, 1.0) * 65535.0;
  o1 = vec4(floor(d16 / 256.0) / 255.0, mod(d16, 256.0) / 255.0, 0.0, 1.0);
}`;
const VS_SHADOW = `#version 300 es
in vec3 aPos; in vec3 aAttr;
uniform mat3 uLV; uniform vec3 uLC; uniform float uLE;
out float vMat;
void main() { vec3 l = (uLV * (aPos - uLC)) / uLE; gl_Position = vec4(l.xy, -l.z, 1.0); vMat = aAttr.x; }`;
const FS_SHADOW = `#version 300 es
precision highp float;
in float vMat; out vec4 o;
void main() { o = vec4(vMat / 255.0, 0.0, 0.0, 1.0); }`;
const VS_QUAD = `#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_DRAW = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uG0; uniform sampler2D uG1;
uniform sampler2D uOv0; uniform sampler2D uOv1; uniform sampler2D uOv2;
uniform float uOvMask[36];           // overlay k applies to material m when uOvMask[k * 12 + m] > 0.5
uniform vec2 uGSize; uniform float uR; uniform float uTau; uniform float uStep[12];
uniform vec3 uLit[12]; uniform vec3 uShade[12]; uniform vec3 uInk; uniform vec3 uWob;
float depthAt(vec2 uv) { vec4 t = texture(uG1, uv); return (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0; }
vec4 one(vec2 uv) {
  vec4 g = texture(uG0, uv);
  float cov = step(0.5, g.a);
  int m = int(g.r * 255.0 + 0.5);
  vec3 col = mix(uShade[m], uLit[m], g.g);
  if (cov > 0.5) {
    vec4 a = texture(uOv0, uv); if (uOvMask[m] > 0.5) col = col * (1.0 - a.a) + a.rgb;
    vec4 b = texture(uOv1, uv); if (uOvMask[12 + m] > 0.5) col = col * (1.0 - b.a) + b.rgb;
    vec4 c = texture(uOv2, uv); if (uOvMask[24 + m] > 0.5) col = col * (1.0 - c.a) + c.rgb;
  }
  float e = 0.0;
  float dc = depthAt(uv);
  for (int i = 0; i < 4; i++) {
    float ang = float(i) * 0.7853982;
    vec2 off = vec2(cos(ang), sin(ang)) * uR / uGSize;
    vec4 ga = texture(uG0, uv + off), gb = texture(uG0, uv - off);
    float ca = step(0.5, ga.a), cb = step(0.5, gb.a);
    if (ca != cov || cb != cov) { e = 1.0; }
    else if (cov > 0.5) {
      if (abs(ga.b - g.b) > 0.002 || abs(gb.b - g.b) > 0.002) e = 1.0;
      else if (abs(depthAt(uv + off) + depthAt(uv - off) - 2.0 * dc) > uTau * uStep[m]) e = 1.0;
    }
  }
  float alpha = max(cov, e);
  return vec4(mix(col, uInk, e) * alpha, alpha);
}
void main() {
  // The drawing breathes: a slow displacement, new on every held drawing.
  vec2 uv = vUv + uWob.x * vec2(sin(vUv.y * 23.0 + uWob.z * 1.7) + 0.6 * sin(vUv.y * 61.0 + uWob.z), sin(vUv.x * 19.0 + uWob.z * 2.3) + 0.6 * sin(vUv.x * 53.0 + uWob.z * 0.7)) / uGSize * 2.0;
  vec2 h = 0.5 / uGSize;
  o = 0.25 * (one(uv + vec2(-h.x, -h.y)) + one(uv + vec2(h.x, -h.y)) + one(uv + vec2(-h.x, h.y)) + one(uv + vec2(h.x, h.y)));
}`;

const SS = 2;

export function makeCel(W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, depth: false });
  if (!gl) return null;
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`cel shader: ${gl.getShaderInfoLog(s)}`); return s; };
  const program = (vs, fs, attribs) => {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`cel program: ${gl.getProgramInfoLog(p)}`);
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i += 1) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  };
  const geom = program(VS_GEOM, FS_GEOM, ['aPos', 'aNor', 'aAttr']);
  const shadow = program(VS_SHADOW, FS_SHADOW, ['aPos', 'aNor', 'aAttr']);
  const draw = program(VS_QUAD, FS_DRAW, []);

  const tex = (w, h, internal, format, type, filter = gl.NEAREST) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const GW = W * SS, GH = H * SS;
  const g0 = tex(GW, GH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), g1 = tex(GW, GH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const gDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, gDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, GW, GH);
  const gFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, gFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, gDepth);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  const SM = 2048;
  const sDepth = tex(SM, SM, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT), sMat = tex(SM, SM, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const sFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, sFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sMat, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sDepth, 0);
  const overlays = [0, 1, 2].map(() => tex(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR));
  const blank = new Uint8Array(4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  for (let i = 0; i < 3; i += 1) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 36, i * 12); }
  let verts = new Float32Array(9 * 60000), indices = new Uint32Array(6 * 60000);

  /** Triangles for solids: { rings, normals, capNormals, mat, inkGroup, shadeBias, noCaps }. */
  function fill(solids) {
    let v = 0, k = 0;
    const need = solids.reduce((s, x) => s + (x.rings.length + 2) * (x.rings[0].length + 1), 0);
    if (need * 9 > verts.length) verts = new Float32Array(need * 9 * 2);
    if (need * 6 > indices.length) indices = new Uint32Array(need * 6 * 2);
    const put = (p, n, s) => { const o = v * 9; verts[o] = p[0]; verts[o + 1] = p[1]; verts[o + 2] = p[2]; verts[o + 3] = n[0]; verts[o + 4] = n[1]; verts[o + 5] = n[2]; verts[o + 6] = s.mat; verts[o + 7] = s.inkGroup ?? s.mat; verts[o + 8] = s.shadeBias || 0; v += 1; return v - 1; };
    for (const s of solids) {
      const m = s.rings.length, n = s.rings[0].length;
      const base = v;
      for (let i = 0; i < m; i += 1) for (let j = 0; j < n; j += 1) put(s.rings[i][j], s.normals[i][j], s);
      for (let i = 0; i < m - 1; i += 1) for (let j = 0; j < n; j += 1) {
        const a = base + i * n + j, b = base + i * n + (j + 1) % n, c = base + (i + 1) * n + (j + 1) % n, d = base + (i + 1) * n + j;
        indices[k++] = a; indices[k++] = b; indices[k++] = c; indices[k++] = a; indices[k++] = c; indices[k++] = d;
      }
      if (!s.noCaps) for (const [ringIndex, normal] of [[0, s.capNormals[0]], [m - 1, s.capNormals[1]]]) {
        const centre = put(s.centers[ringIndex], normal, s);
        const first = v;
        for (let j = 0; j < n; j += 1) put(s.rings[ringIndex][j], normal, s);
        for (let j = 0; j < n; j += 1) { indices[k++] = centre; indices[k++] = first + j; indices[k++] = first + (j + 1) % n; }
      }
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, v * 9), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices.subarray(0, k), gl.DYNAMIC_DRAW);
    return k;
  }
  const hex3 = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

  // Math helpers use row-major matrices; WebGL requires column-major data and transpose=false.
  const columnMajor = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

  return {
    canvas,
    /**
     * Draw solids into the cel canvas (transparent where there is no figure).
     * view: { V, s, cx, cy }; light: unit vector toward the light; centre: a point near the figure's middle;
     * materials: [{ lit, shade, backDark }], indexed by solid.mat (index 0 is unused);
     * overlays: up to three { canvas, materials: [indices] } of 2D-drawn detail.
     */
    render({ solids, view, light, centre, materials, overlays: layers = [], lineWidth = 2.2, ink = '#1b1736', terminator = 0.08, depthStep = 0.011, wobble = 0, wobbleSeed = 0, shadows = true, reach = 1.5 }) {
      const count = fill(solids);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
      // Light basis: rows x, y, z with z toward the light.
      const lz = light;
      let lx = [lz[1] * 0 - lz[2] * 1, lz[2] * 0 - lz[0] * 0, lz[0] * 1 - lz[1] * 0]; // up x lz
      const ll = Math.hypot(...lx) || 1; lx = lx.map((c) => c / ll);
      const ly = [lz[1] * lx[2] - lz[2] * lx[1], lz[2] * lx[0] - lz[0] * lx[2], lz[0] * lx[1] - lz[1] * lx[0]];
      const LV = [...lx, ...ly, ...lz];
      gl.bindVertexArray(vao);
      if (shadows) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, sFbo); gl.viewport(0, 0, SM, SM); gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(shadow.p);
        gl.uniformMatrix3fv(shadow.u.uLV, false, columnMajor(LV)); gl.uniform3fv(shadow.u.uLC, centre); gl.uniform1f(shadow.u.uLE, reach);
        gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
      }
      // The forms.
      gl.bindFramebuffer(gl.FRAMEBUFFER, gFbo); gl.viewport(0, 0, GW, GH);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(geom.p);
      gl.uniformMatrix3fv(geom.u.uV, false, columnMajor(view.V));
      const zc = view.V[6] * centre[0] + view.V[7] * centre[1] + view.V[8] * centre[2];
      gl.uniform4f(geom.u.uScr, view.s, view.cx, view.cy, zc);
      gl.uniform2f(geom.u.uSize, W, H); gl.uniform1f(geom.u.uRange, 2.2);
      gl.uniformMatrix3fv(geom.u.uLV, false, columnMajor(LV)); gl.uniform3fv(geom.u.uLC, centre); gl.uniform1f(geom.u.uLE, reach);
      gl.uniform3fv(geom.u.uL, light); gl.uniform1f(geom.u.uTerm, terminator);
      const backDark = new Float32Array(12); materials.forEach((m, i) => { if (m?.backDark) backDark[i] = 1; });
      gl.uniform1fv(geom.u.uBackDark, backDark);
      const cast = new Float32Array(12).fill(1); materials.forEach((m, i) => { if (m?.castReach) cast[i] = m.castReach / (2 * reach); });
      gl.uniform1fv(geom.u.uCastReach, cast);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sDepth); gl.uniform1i(geom.u.uShadow, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sMat); gl.uniform1i(geom.u.uShadowMat, 1);
      gl.uniform1f(geom.u.uShadowOn, shadows ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
      // The drawing.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(draw.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g0); gl.uniform1i(draw.u.uG0, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g1); gl.uniform1i(draw.u.uG1, 1);
      const mask = new Float32Array(36);
      for (let i = 0; i < 3; i += 1) {
        gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, overlays[i]);
        const layer = layers[i];
        if (layer) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.canvas); for (const m of layer.materials) mask[i * 12 + m] = 1; } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blank);
        gl.uniform1i(draw.u[`uOv${i}`], 2 + i);
      }
      gl.uniform1fv(draw.u.uOvMask, mask);
      gl.uniform2f(draw.u.uGSize, GW, GH); gl.uniform1f(draw.u.uR, (lineWidth / 2) * SS); gl.uniform1f(draw.u.uTau, depthStep / (2.2 * 2));
      const steps = new Float32Array(12).fill(1); materials.forEach((m, i) => { if (m?.depthStep) steps[i] = m.depthStep; });
      gl.uniform1fv(draw.u.uStep, steps);
      const lit = new Float32Array(36), shade = new Float32Array(36);
      materials.forEach((m, i) => { if (!m) return; lit.set(hex3(m.lit), i * 3); shade.set(hex3(m.shade), i * 3); });
      gl.uniform3fv(draw.u.uLit, lit); gl.uniform3fv(draw.u.uShade, shade); gl.uniform3fv(draw.u.uInk, hex3(ink));
      gl.uniform3f(draw.u.uWob, wobble, 0, wobbleSeed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
      return canvas;
    },
  };
}
