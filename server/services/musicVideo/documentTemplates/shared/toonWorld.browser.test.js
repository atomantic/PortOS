import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun } from '../../../../lib/browserSuiteGate.js';

const require = createRequire(import.meta.url);
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => p && existsSync(p));
const canRun = browserSuiteCanRun('toon world browser', { Chrome: chrome });
const root = dirname(fileURLToPath(import.meta.url));
const threeRoot = dirname(require.resolve('three'));

describe.skipIf(!canRun)('toon world headless dish proof', () => {
  let browser, page;
  const errors = [];
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, headless: true,
      args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('http://toon.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === '') return route.fulfill({ contentType: 'text/html', body: '<canvas id="world"></canvas><script type="module" src="fixture.js"></script>' });
      if (name === 'fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
      const files = { 'toonWorld.js': join(root, 'toonWorld.js'), 'engine.js': join(root, '../spatial/engine.js'),
        'vendor/three.module.js': join(threeRoot, 'three.module.js'), 'vendor/three.core.js': join(threeRoot, 'three.core.js') };
      if (!files[name]) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(files[name]) });
    });
    await page.goto('http://toon.test/');
    await page.waitForFunction(() => window.proof);
  }, 30000);
  afterAll(async () => { await browser?.close(); });

  it('renders thick, separated dishes and refuses hidden ink with optical passes on/off', async () => {
    const results = await page.evaluate(() => window.proof());
    expect(results.overlaps).toEqual([]);
    expect(results.inkChanged).toBeGreaterThan(300);
    expect(results.hiddenChanged).toBe(0);
    expect(results.flatChanged).toBe(0);
    expect(new Set(results.views).size).toBe(3);
    expect(results.postChanged).toBeGreaterThan(1000);
    expect(results.darkInkCount).toBeGreaterThan(100);
    expect(results.bloomOverInk).toBe(0);
    expect(results.repeat).toBe(true);
    expect(errors).toEqual([]);
    console.log(`🎨 Toon dish proof: baseline ${results.baselineMs.toFixed(1)}ms, ink ${results.inkMs.toFixed(1)}ms, ratio ${results.ratio.toFixed(2)}`);
    if (process.env.PORTOS_TOON_PROOF_IMAGE) await page.screenshot({ path: process.env.PORTOS_TOON_PROOF_IMAGE });
    // SwiftShader (forced above) rasterises the extra full-screen ink pass in software, so CI Linux measures ~1.6x
    // where a hardware GPU stays near 1.5x. 2x still fails a doubled-cost regression such as a second geometry pass.
    expect(results.ratio).toBeLessThanOrEqual(2);
  }, 60000);

  it('supports a manual/layered post stack and restores the caller target', async () => {
    const result = await page.evaluate(() => window.manualProof());
    expect(result.changed).toBeGreaterThan(300);
    expect(result.restored).toBe(true);
    expect(result.feedbackRefused).toBe(true);
    expect(errors).toEqual([]);
  });
});

const fixture = `
import * as THREE from './vendor/three.module.js';
import * as kit from './toonWorld.js';
import { createPost } from './engine.js';
const renderer = new THREE.WebGLRenderer({canvas:document.getElementById('world'),preserveDrawingBuffer:true});
renderer.setSize(640,360,false); renderer.shadowMap.enabled=true;
const post=createPost(THREE,renderer);post.resize(640,360);
const scene=new THREE.Scene();scene.background=new THREE.Color('#65556e');
const camera=new THREE.PerspectiveCamera(40,640/360,.1,100);
camera.position.set(9,8,17);camera.lookAt(0,1,0);
const sun=new THREE.DirectionalLight('#ffe2ad',2);sun.position.set(-7,8,4);sun.castShadow=true;
sun.shadow.mapSize.set(512,512);sun.shadow.camera.left=-14;sun.shadow.camera.right=14;
sun.shadow.camera.top=10;sun.shadow.camera.bottom=-10;scene.add(sun);
scene.add(new THREE.AmbientLight('#927fa5',.15));
const material=kit.toonMaterial(THREE,{lit:'#f6d89e',mid:'#b98c88',shadow:'#65518b'});
const profile=Array.from({length:25},(_,i)=>[i/24,(i/24)**2*.6]);
const dishes=kit.layoutRow({count:7,footprint:2.3,gap:.5,curve:x=>Math.cos(x*.2)}).map(p=>{
  const dish=new THREE.Mesh(kit.shellLathe(profile,.12,64),material);
  dish.position.set(p.x,1.2,p.z);dish.castShadow=true;dish.receiveShadow=true;scene.add(dish);
  const stand=new THREE.Mesh(new THREE.CylinderGeometry(.1,.16,1.2,12),material);
  stand.position.set(p.x,.6,p.z);stand.castShadow=true;scene.add(stand);return dish;
});
const ground=new THREE.Mesh(new THREE.PlaneGeometry(80,80),kit.toonMaterial(THREE,{lit:'#cf987b',mid:'#a57280',shadow:'#58436a'}));
ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const pixels=()=>{const gl=renderer.getContext(),p=new Uint8Array(640*360*4);gl.readPixels(0,0,640,360,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;};
const changed=(a,b,region=()=>true)=>{let count=0;for(let i=0;i<a.length;i+=4)if(region(i/4)&&a.slice(i,i+3).some((v,j)=>Math.abs(v-b[i+j])>3))count++;return count;};
const draw=(lens={})=>{post.render(scene,camera,lens,0);renderer.getContext().finish();return pixels();};
window.manualProof=()=>{
  const input=new THREE.WebGLRenderTarget(640,360,{type:THREE.HalfFloatType,depthTexture:new THREE.DepthTexture(640,360,THREE.FloatType)});
  const output=new THREE.WebGLRenderTarget(640,360,{depthBuffer:false});
  const ink=kit.createInkPass(THREE,renderer);
  renderer.setRenderTarget(input);renderer.render(scene,camera);
  const read=()=>{const p=new Uint8Array(640*360*4);renderer.readRenderTargetPixels(output,0,0,640,360,p);return p;};
  ink.render(input,camera,output,{enabled:false});const baseline=read();
  ink.render(input,camera,output);const outlined=read();
  const restored=renderer.getRenderTarget()===input;
  let feedbackRefused=false;try{ink.render(input,camera,input);}catch{feedbackRefused=true;}
  renderer.setRenderTarget(null);ink.dispose();input.dispose();output.dispose();
  return {changed:changed(baseline,outlined),restored,feedbackRefused};
};
window.proof=()=>{
  const baseline=draw(), ink=draw({ink:true});
  const inkChanged=changed(baseline,ink);
  const blackInk=draw({ink:{color:'#000000',width:2}});
  const bloomedInk=draw({ink:{color:'#000000',width:2},bloom:4,bloomThreshold:0});
  let darkInkCount=0,bloomOverInk=0;
  for(let i=0;i<blackInk.length;i+=4){
    if(blackInk.slice(i,i+3).every(v=>v<3)&&baseline.slice(i,i+3).some(v=>v>50)){
      darkInkCount++;if(bloomedInk.slice(i,i+3).some(v=>v>3))bloomOverInk++;
    }
  }
  // Empty ground in the lower left has no silhouette or crease.
  const flatChanged=changed(baseline,ink,index=>{const x=index%640,y=Math.floor(index/640);return x>30&&x<100&&y>30&&y<100;});
  const views=[];
  for(const p of [[9,8,17],[8,.7,14],[0,2,19]]){camera.position.set(...p);camera.lookAt(0,1.2,0);draw({ink:true});views.push(document.getElementById('world').toDataURL());}
  camera.position.set(9,8,17);camera.lookAt(0,1,0);
  const before=draw({ink:true});
  const withPost=draw({ink:true,aperture:6,focus:10,maxBlur:8,bloom:.3,bloomThreshold:.2,exposure:1.1,grain:.03});
  const postChanged=changed(before,withPost);
  const repeat=changed(withPost,draw({ink:true,aperture:6,focus:10,maxBlur:8,bloom:.3,bloomThreshold:.2,exposure:1.1,grain:.03}))===0;
  // A solid flat blocker fills the central screen; dishes remain behind it.
  const blocker=new THREE.Mesh(new THREE.PlaneGeometry(8,8),new THREE.MeshBasicMaterial({color:'#63aa85'}));
  blocker.position.copy(camera.position).multiplyScalar(.65);blocker.lookAt(camera.position);scene.add(blocker);
  const noInk=draw(), yesInk=draw({ink:true});
  const hiddenChanged=changed(noInk,yesInk,index=>{const x=index%640,y=Math.floor(index/640);return x>260&&x<380&&y>130&&y<230;});
  scene.remove(blocker);
  // Alternate measured runs, finish the GPU, and use medians after warmup.
  for(let i=0;i<4;i++){draw();draw({ink:true});}
  const a=[],b=[];
  for(let i=0;i<15;i++){
    for(const enabled of (i%2?[true,false]:[false,true])){
      const start=performance.now();post.render(scene,camera,enabled?{ink:true}:{},0);pixels();
      (enabled?b:a).push(performance.now()-start);
    }
  }
  const median=values=>values.sort((x,y)=>x-y)[Math.floor(values.length/2)];
  const baselineMs=median(a),inkMs=median(b);
  return {overlaps:kit.warnOverlaps(THREE,dishes),darkInkCount,bloomOverInk,inkChanged,hiddenChanged,flatChanged,views,postChanged,repeat,baselineMs,inkMs,ratio:inkMs/baselineMs};
};
`;
