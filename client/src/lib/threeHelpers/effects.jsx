// Animates floating avatar geometry, simplex-displaced physical materials, sparkles and star fields.
import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, Color, MathUtils, Vector3 } from 'three';

// Motion envelopes and point profiles adapted from Drei (see LICENSE.drei).
export function Float({ speed, rotationIntensity, floatIntensity, children }) {
  const group = useRef(null);
  const [offset] = useState(() => Math.random() * 10000);
  useFrame(({ clock }) => {
    const phase = (clock.elapsedTime + offset) * speed / 4;
    const wave = Math.sin(phase);
    group.current.rotation.set(Math.cos(phase) * rotationIntensity / 8, wave * rotationIntensity / 8, wave * rotationIntensity / 20);
    group.current.position.y = wave * floatIntensity / 10;
  });
  return <group ref={group}>{children}</group>;
}

const simplex = `
  uniform float phase, distortion;
  vec3 gradientAt(vec3 p) {
    vec3 seed = vec3(dot(p, vec3(127.1,311.7,74.7)), dot(p, vec3(269.5,183.3,246.1)), dot(p, vec3(113.5,271.9,124.6)));
    return normalize(fract(sin(seed) * 43758.5453) * 2. - 1.);
  }
  float contribution(vec3 cell, vec3 offset) {
    float weight = max(0., .6 - dot(offset, offset));
    return weight * weight * weight * weight * dot(gradientAt(cell), offset);
  }
  float displacement(vec3 point) {
    vec3 cell = floor(point + dot(point, vec3(1./3.)));
    vec3 p = point - cell + dot(cell, vec3(1./6.));
    vec3 order = step(p.yzx, p.xyz);
    vec3 a = min(order, 1. - order.zxy);
    vec3 b = max(order, 1. - order.zxy);
    return 38. * (contribution(cell, p) + contribution(cell+a, p-a+1./6.) +
      contribution(cell+b, p-b+1./3.) + contribution(cell+1., p-.5));
  }
`;
export function MeshDistortMaterial({ speed, distort, ...props }) {
  const uniforms = useMemo(() => ({ phase: { value: 0 }, distortion: { value: 0 } }), []);
  useFrame(({ clock }) => {
    uniforms.phase.value = clock.elapsedTime * speed * 0.1;
    uniforms.distortion.value = distort;
  });
  const compile = useMemo(() => shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = simplex + shader.vertexShader.replace('#include <begin_vertex>',
      'vec3 transformed = position * (1. + displacement(position * .5 + phase) * distortion * distortion);');
  }, [uniforms]);
  return <meshPhysicalMaterial {...props} onBeforeCompile={compile} />;
}

const sparkVertex = `
  uniform float time, size, noise, pixelRatio;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.);
    float phase = time + world.x * noise * 100.;
    world.xyz += .2 * vec3(cos(phase), sin(phase), cos(phase));
    vec4 view = viewMatrix * world;
    gl_PointSize = size * 25. * pixelRatio / -view.z;
    gl_Position = projectionMatrix * view;
  }`;
const sparkFragment = `
  uniform vec3 tint;
  uniform float opacity;
  void main() {
    float strength = .05 / max(.001, distance(gl_PointCoord, vec2(.5))) - .1;
    gl_FragColor = vec4(tint, opacity * strength);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
export function Sparkles({ count, scale, size, color, speed, noise = 1, opacity = 1 }) {
  const dpr = useThree(state => state.viewport.dpr);
  const points = useMemo(() => Float32Array.from({ length: count * 3 }, () => MathUtils.randFloatSpread(scale)), [count, scale]);
  const uniforms = useMemo(() => ({
    time: { value: 0 }, tint: { value: new Color(color) }, opacity: { value: opacity },
    pixelRatio: { value: dpr }, size: { value: size }, noise: { value: noise },
  }), [color, dpr, noise, opacity, size]);
  const material = useRef(null);
  useFrame(({ clock }) => { material.current.uniforms.time.value = clock.elapsedTime * speed; });
  return <points>
    <bufferGeometry><bufferAttribute attach="attributes-position" args={[points, 3]} /></bufferGeometry>
    <shaderMaterial ref={material} uniforms={uniforms} vertexShader={sparkVertex} fragmentShader={sparkFragment} depthWrite={false} transparent />
  </points>;
}

const starVertex = `
  uniform float time;
  attribute float size;
  varying vec3 tint;
  void main() {
    tint = color;
    vec4 view = modelViewMatrix * vec4(position, .5);
    gl_PointSize = size * (30. / -view.z) * (3. + sin(time + 100.));
    gl_Position = projectionMatrix * view;
  }`;
const starFragment = `
  uniform bool fade;
  varying vec3 tint;
  void main() {
    float alpha = fade ? 1. / (1. + exp(16. * (distance(gl_PointCoord, vec2(.5)) - .25))) : 1.;
    gl_FragColor = vec4(tint, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
export function Stars({ count, radius, depth, factor, saturation, speed, fade }) {
  const stars = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const point = new Vector3();
    const tint = new Color();
    let shell = radius + depth;
    for (let i = 0; i < count; i++) {
      shell -= depth / count * Math.random();
      point.randomDirection().multiplyScalar(shell).toArray(positions, i * 3);
      tint.setHSL(i / count, saturation, .9).toArray(colors, i * 3);
      sizes[i] = factor * (0.5 + 0.5 * Math.random());
    }
    return { positions, colors, sizes };
  }, [count, depth, factor, radius, saturation]);
  const uniforms = useMemo(() => ({ time: { value: 0 }, fade: { value: fade } }), [fade]);
  const material = useRef(null);
  useFrame(({ clock }) => { material.current.uniforms.time.value = clock.elapsedTime * speed; });
  return <points>
    <bufferGeometry>
      <bufferAttribute attach="attributes-position" args={[stars.positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[stars.colors, 3]} />
      <bufferAttribute attach="attributes-size" args={[stars.sizes, 1]} />
    </bufferGeometry>
    <shaderMaterial ref={material} uniforms={uniforms} vertexShader={starVertex} fragmentShader={starFragment}
      vertexColors blending={AdditiveBlending} depthWrite={false} transparent />
  </points>;
}
