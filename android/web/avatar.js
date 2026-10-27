// The avatar on the phone: the user's own VRM model (the one their character wears in Astra), drawn
// with three.js + three-vrm. Bundled by android/build.js into assets/avatar.js (window.AvatarKit).
//
// Between motions she is posed by code: arms down, breathing, blinking, glancing about. The pack's
// VRMA motions play over that (an idle one now and then, a reaction on a tap), and while Astra's reply
// is spoken her mouth moves. Drawing stops while the page is hidden and runs at 30 fps otherwise.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";

const FRAME_MS = 1000 / 30;

function create(canvas, { onTap } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 1.4, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xf38ba8, 0.9); // Astra's strawberry, from behind
  rim.position.set(-1, 1.2, -1.2);
  scene.add(rim);

  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  loader.register((p) => new VRMAnimationLoaderPlugin(p));

  let vrm = null, mixer = null, action = null, raf = 0, last = 0, t = 0, flip = 1;
  let talking = false, mouth = 0, mood = null, moodUntil = 0, blinkAt = 2, blink = 0;
  const look = new THREE.Object3D();
  scene.add(look);
  const anims = new Map(); // url → VRMAnimation

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // upper body in frame, a little room above the head
  function frame() {
    const head = vrm.humanoid.getNormalizedBoneNode("head");
    const p = new THREE.Vector3();
    head.getWorldPosition(p);
    const y = p.y - 0.22;
    camera.position.set(0, y + 0.04, 1.85);
    camera.lookAt(0, y, 0);
    look.position.set(0, p.y, 1.5);
  }

  // The pose between motions; it is also what a motion fades from and back to. Angles are for a VRM 1.0
  // model, which faces +Z; a VRM 0.x one faces -Z, so its X and Z turns go the other way round
  // (unflipped, its arms went up instead of down).
  const FINGERS = [["Index", 0.22], ["Middle", 0.3], ["Ring", 0.38], ["Little", 0.46]];
  function idlePose(dt) {
    const set = (name, x, y, z) => {
      const o = vrm.humanoid.getNormalizedBoneNode(name);
      if (o) o.rotation.set(x * flip, y, z * flip);
    };
    const breath = Math.sin(t * 1.6);
    const sway = Math.sin(t * 0.42); // the weight going from foot to foot
    const swing = Math.sin(t * 0.42 + 1.3); // the arms follow it a little later
    set("hips", 0, sway * 0.04, sway * 0.025);
    set("spine", breath * 0.015, -sway * 0.03, -sway * 0.035);
    set("chest", breath * 0.025, Math.sin(t * 0.31) * 0.03, 0);
    set("upperChest", breath * 0.015, 0, 0);
    set("neck", Math.sin(t * 0.27) * 0.03, Math.sin(t * 0.23) * 0.08, sway * 0.02);
    set("head", Math.sin(t * 0.37 + 0.5) * 0.04, Math.sin(t * 0.19) * 0.07, Math.sin(t * 0.33) * 0.05);
    set("leftShoulder", 0, 0, 0.02 + breath * 0.012);
    set("rightShoulder", 0, 0, -0.02 - breath * 0.012);
    // arms down along the body, a little forward, elbows soft, hands and fingers relaxed
    set("leftUpperArm", 0, -0.14 - swing * 0.04, -1.24 + breath * 0.02);
    set("rightUpperArm", 0, 0.14 - swing * 0.04, 1.24 - breath * 0.02);
    set("leftLowerArm", 0, -0.38 - swing * 0.03, 0);
    set("rightLowerArm", 0, 0.38 - swing * 0.03, 0);
    set("leftHand", 0, -0.08, -0.12);
    set("rightHand", 0, 0.08, 0.12);
    for (const [f, c] of FINGERS) {
      set(`left${f}Proximal`, 0, 0, -c);
      set(`left${f}Intermediate`, 0, 0, -c * 0.9);
      set(`left${f}Distal`, 0, 0, -c * 0.6);
      set(`right${f}Proximal`, 0, 0, c);
      set(`right${f}Intermediate`, 0, 0, c * 0.9);
      set(`right${f}Distal`, 0, 0, c * 0.6);
    }
  }

  function expressions(dt) {
    const e = vrm.expressionManager;
    if (!e) return;
    // blink every 2–6 s
    blinkAt -= dt;
    if (blinkAt <= 0) { blink = 1; blinkAt = 2 + Math.random() * 4; }
    blink = Math.max(0, blink - dt * 7);
    e.setValue("blink", blink > 0.5 ? 2 - blink * 2 : blink * 2);
    // the mouth while she speaks
    const target = talking ? 0.25 + 0.55 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 3.1)) : 0;
    mouth += (target - mouth) * Math.min(1, dt * 18);
    e.setValue("aa", mouth);
    e.setValue("oh", talking ? Math.max(0, Math.sin(t * 5.3)) * 0.25 : 0);
    // a mood, fading out
    for (const name of ["happy", "sad", "angry", "surprised", "relaxed"]) {
      const want = mood === name && t < moodUntil ? 0.75 : 0;
      const cur = e.getValue(name) || 0;
      e.setValue(name, cur + (want - cur) * Math.min(1, dt * 4));
    }
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (document.hidden || now - last < FRAME_MS) return;
    const dt = Math.min(0.1, (now - last) / 1000 || 0.033);
    last = now;
    t += dt;
    if (!vrm) return;
    // a motion fades out over its last 0.4 s, back to the pose between motions
    if (action && action.time >= action.getClip().duration - 0.4) {
      action.fadeOut(0.4);
      action = null;
    }
    if (!action) idlePose(dt);
    mixer?.update(dt);
    // the eyes follow a point near the camera that wanders a little
    look.position.x = Math.sin(t * 0.37) * 0.25;
    look.position.y = camera.position.y + Math.sin(t * 0.29) * 0.08;
    expressions(dt);
    vrm.update(dt);
    renderer.render(scene, camera);
  }

  async function load(url) {
    const gltf = await loader.loadAsync(url);
    const v = gltf.userData.vrm;
    if (!v) throw new Error("Это не модель VRM");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(v);
    v.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = v;
    flip = v.meta?.metaVersion === "0" ? -1 : 1;
    scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = look;
    t = 0;
    idlePose(0);
    vrm.update(0);
    frame();
    // the pose a motion is blended with is captured when the mixer first binds: the arms-down one
    mixer = new THREE.AnimationMixer(vrm.scene);
    resize();
  }

  // play a VRMA motion once, crossfading from whatever she is doing
  async function play(url) {
    if (!vrm) return;
    let anim = anims.get(url);
    if (!anim) {
      const g = await loader.loadAsync(url);
      anim = g.userData.vrmAnimations?.[0];
      if (!anim) return;
      anims.set(url, anim);
    }
    const clip = createVRMAnimationClip(anim, vrm);
    // her face is driven here (mouth, blinks, mood): the motion's own expression keys are left out
    clip.tracks = clip.tracks.filter((tr) => !/\.weight$/.test(tr.name));
    const next = mixer.clipAction(clip);
    next.reset();
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true; // held on its last frame while it fades out (see tick)
    next.fadeIn(0.35);
    if (action) action.crossFadeTo(next, 0.35, false);
    next.play();
    action = next;
  }

  canvas.addEventListener("pointerup", () => onTap && onTap());
  window.addEventListener("resize", resize);
  raf = requestAnimationFrame(tick);

  return {
    load,
    play,
    busy: () => !!action,
    setTalking(on) { talking = !!on; },
    setMood(name, seconds = 4) { mood = name; moodUntil = t + seconds; },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
    }
  };
}

window.AvatarKit = { create };
