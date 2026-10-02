// Synthetic author output used by browser and workflow contract tests only.
export const richSceneSource = `function render(ctx, env) {
  const { THREE, scene, camera, text } = ctx;
  scene.background = new THREE.Color('#102030');
  scene.add(new THREE.HemisphereLight(0xbbeeff, 0x223344, 2));
  const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(2, 5, 4); key.castShadow=true; scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30,30), new THREE.MeshStandardMaterial({color:0x294358}));
  floor.receiveShadow=true; floor.rotation.x = -Math.PI/2; scene.add(floor);
  for (let i=0; i<9; i++) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.7,2+i%3,0.8), new THREE.MeshStandardMaterial({color:0x456781}));
    tower.position.set((i-4)*1.2,1,-4); scene.add(tower);
  }
  const character = new THREE.Group(); scene.add(character);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7,1.2,0.5), new THREE.MeshStandardMaterial({color:0xff9933})); body.castShadow=true; body.position.y=1.3; character.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35,16,12), new THREE.MeshStandardMaterial({color:0xffddaa})); head.position.y=2.2; character.add(head);
  for (const side of [-1,1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.9,0.18), body.material); arm.position.set(side*0.65,1.3,0); arm.rotation.z=side*(0.4+0.7*Math.sin(env.t*4)); character.add(arm);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.23,0.7,0.25), body.material); leg.position.set(side*0.22,0.35,0); character.add(leg);
  }
  character.position.x=Math.sin(env.t*2)*1.5;
  camera.position.set(Math.sin(env.t)*2,3,8); camera.lookAt(0,1,0);
  text.font='40px "MV Mono"'; text.fillStyle='#ffffff'; text.fillText('EXAMPLE WORLD',env.width*0.1,env.height*0.15);
}`;
