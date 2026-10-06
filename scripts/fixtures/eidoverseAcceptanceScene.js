/** Authored synthetic inputs only: no assets, provider calls or instance data. */
export function acceptanceScene({ marker = 'synthetic', mode = 'geometry' } = {}) {
  return { inlineScript: `// PortOS acceptance: ${marker}
globalThis.setup = async () => {
  ${mode === 'cancel' ? 'await new Promise(resolve => setTimeout(resolve, 600000));' : ''}
  ${mode === 'failure' ? 'Deno.writeTextFileSync("/output/intentional-failure.txt", "synthetic"); await new Promise(resolve => setTimeout(resolve, 1500)); throw new Error("synthetic acceptance failure");' : ''}
  globalThis._noAutoEnhance = true;
  const scene = globalThis._scene = new THREE.Scene();
  scene.background = new THREE.Color('#101018');
  const camera = globalThis._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  const renderer = globalThis._renderer = new THREE.WebGPURenderer({ canvas, adapter: GPU_ADAPTER, device: GPU_DEVICE, antialias: false });
  renderer.setSize(WIDTH, HEIGHT); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.1), new THREE.MeshBasicMaterial({ color: '#20e060' }));
  box.position.set(-0.55, 0.4, 0); scene.add(box);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), new THREE.MeshBasicMaterial({ color: '#2050f0' }));
  sphere.position.set(0.55, 0.4, 0); scene.add(sphere);
  const moving = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.1), new THREE.MeshBasicMaterial({ color: '#f03020' }));
  moving.position.set(-0.45, -0.35, 0); scene.add(moving);
  // State is accumulated per simulation step, never derived from seek time.
  let steps = 0;
  globalThis.renderFrame = async () => {
    moving.position.x = -0.45 + 0.018 * steps++;
    await renderer.renderAsync(scene, camera);
  };
};` };
}

/** Two distinguishable time segments catch muxing from zero on an excerpt. */
export function syntheticSong() {
  const rate = 48000;
  const samples = rate * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const frequency = i < rate ? 330 : 880;
    wav.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  }
  return wav;
}
