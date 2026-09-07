import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AudioAnalyser } from './audio.js';
import { tracks } from './album.js';

// Test harness for a "buildings" alternative to the rock terrain: instead of
// a fixed grid sampling a scrolling texture (which reads as static cells
// changing height, not motion), this mirrors trees.js's own model exactly --
// real instanced boxes that spawn at the far edge with a height fixed once
// and for all at birth, then physically travel toward the camera over a
// fixed lifetime, retiring on arrival. A first version raymarched an SDF
// grid instead; that's fundamentally the wrong tool for many independently
// moving objects (each one would need its own evaluation inside the marching
// loop, which doesn't scale), so this drops raymarching entirely in favour
// of a plain instanced mesh, exactly like the trees.

const WIDTH = 24;
const DEPTH = 48;
const BINS = 128;
const AMPLITUDE = 6;
// Matches terrain.js's own crossing time: one column of data takes this many
// rendered frames (~4.3s @60fps) to travel the full depth, same as the rock
// terrain's own waterfall.
const CROSSING_FRAMES = 256;
// A fresh generation is spawned per lane every this-many rendered frames --
// purely a spatial/density knob (how many buildings fit along one lane's
// length), not an averaging window: each generation's height is a single raw
// sample taken once at spawn, never touched again. Denser (small stride)
// costs more instances; 128 bins x 2 channels x (crossing/stride) instances.
const SPAWN_INTERVAL = 4;
const LANES_PER_CHANNEL = 32; // sampled from BINS at a stride, like a coarser skyline
const BIN_STRIDE = Math.floor(BINS / LANES_PER_CHANNEL);
const GENERATIONS_PER_LANE = Math.round(CROSSING_FRAMES / SPAWN_INTERVAL);
const TOTAL_LANES = LANES_PER_CHANNEL * 2; // left + right
const MAX_INSTANCES = TOTAL_LANES * GENERATIONS_PER_LANE;
// Precomputed per-bin average amplitude for this track (see the 'p' export
// below) -- a bin only spawns a building when it's currently at or above this
// fraction of its OWN typical level, instead of one global floor. Decided
// once at spawn, like the height -- never re-evaluated during the crossing.
const PROFILE_THRESHOLD = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 26, 34);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const light = new THREE.DirectionalLight(0xffffff, 1.2);
light.position.set(3, 6, 7);
scene.add(light);
scene.add(new THREE.AmbientLight(0x8fa8c9, 0.4));

// Same integration trick the rock terrain uses: fade distant/far geometry
// toward the backdrop instead of a hard silhouette sitting on top of it, so
// this reads as part of the same scene rather than a solid shape pasted over
// the page's own gradient. A plain built-in material (unlike terrain's fully
// custom ShaderMaterial) gets three.js's own fog wiring for free -- density
// tuned so the far spawn edge (~58 world units from the camera) fades most
// of the way into the fog colour by the time a building arrives there.
scene.fog = new THREE.FogExp2(0x140a1c, 0.02);

// A unit box pivoted at its own base (not its centre), so scale.y alone
// controls height without also having to reposition it -- same trick
// trees.js uses for the trunk/foliage geometry.
const cellWidth = (WIDTH / 2 / LANES_PER_CHANNEL) * 0.85;
const cellDepth = (DEPTH / GENERATIONS_PER_LANE) * 0.85;
const boxGeometry = new THREE.BoxGeometry(cellWidth, 1, cellDepth);
boxGeometry.translate(0, 0.5, 0);
// transparent + partial opacity, like the terrain's own largely-translucent
// look, so the page's gradient still shows through rather than solid opaque
// boxes sitting flatly on top of it.
const boxMaterial = new THREE.MeshLambertMaterial({
  color: 0x8fa8c9,
  flatShading: true,
  transparent: true,
  opacity: 0.85,
});
const mesh = new THREE.InstancedMesh(boxGeometry, boxMaterial, MAX_INSTANCES);
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
mesh.frustumCulled = false; // see trees.js's own note -- default bounding sphere is wrong for spread-out instances
scene.add(mesh);

const dummy = new THREE.Object3D();
const slots = Array.from({ length: MAX_INSTANCES }, () => ({ active: false, height: 0, spawnFrame: 0, worldX: 0 }));

function hideInstance(i) {
  dummy.position.set(0, -1000, 0);
  dummy.scale.set(1, 0.0001, 1);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
}
for (let i = 0; i < MAX_INSTANCES; i++) hideInstance(i);
mesh.instanceMatrix.needsUpdate = true;

function laneWorldX(laneIndexInChannel, channel) {
  const bin = laneIndexInChannel * BIN_STRIDE;
  const sampleU = (bin + 0.5) / BINS;
  const u = channel === 0 ? sampleU * 0.5 : 0.5 + sampleU * 0.5;
  return (u - 0.5) * WIDTH;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Track picked via ?track=<slug> (defaults to orange-pressee) -- this page
// doubles as the profile-capture tool for buildings.js's per-track
// threshold JSON (press 'p'), so it needs to be able to point at whichever
// track is missing one, not just the one it was first built against.
const analyser = new AudioAnalyser(BINS);
const noteEl = document.getElementById('note');
let started = false;
const trackSlug = new URLSearchParams(location.search).get('track') || 'orange-pressee';
const track = tracks.find((t) => t.slug === trackSlug) || tracks.find((t) => t.slug === 'orange-pressee');
const trackFile = track.file;

// Loops on its own once the track ends -- without this, a long test session
// eventually runs the track out, playback silently stops, and everything
// visibly freezes with no error and no way to resume short of reloading.
analyser.onEnded = () => {
  analyser.loadURL(trackFile).catch((err) => console.error('loop', err));
};

async function start() {
  if (started) return;
  started = true;
  await analyser.unlock();
  // Silent -- pure visual iteration, no need to hear it out loud.
  analyser.setVolume(0);
  await analyser.loadURL(trackFile);
  noteEl.textContent = `${track.title} (muet) -- glissez pour orbiter, comme le terrain principal`;
}
window.addEventListener('pointerdown', start);
window.addEventListener('keydown', start);

// Adaptive envelope (peak-hold with a slow release), so dynamic contrast
// between bins stays visible whether the track is loud or quiet right now --
// a fixed AMPLITUDE scale means a quiet passage just reads as uniformly short
// buildings. Jumps up instantly to a new peak (attack), decays slowly if
// nothing tops it (release), floored so near-silence doesn't get amplified
// into visible noise.
let envelope = 60;
const ENVELOPE_RELEASE = 0.995; // per frame -- roughly a few seconds to fully relax
const ENVELOPE_FLOOR = 30;

let hasProfile = false;
let profileValues = null; // one typical-average byte per bin, loaded from /<slug>-profile.json

fetch(`/${trackSlug}-profile.json`)
  .then((res) => (res.ok ? res.json() : null))
  .then((profile) => {
    if (!profile || !profile.values) return;
    profileValues = profile.values;
    hasProfile = true;
    noteEl.textContent += ' -- profil chargé';
  })
  .catch(() => {});

// Running per-bin average, accumulated live while the track plays -- press
// 'p' to export it as this track's own profile JSON (save the download into
// public/ under that name, then reload to pick it up). This is the only
// place any averaging happens -- it builds the static threshold reference,
// offline; it never smooths the live per-frame data itself.
const profileSum = new Float64Array(BINS);
let profileCount = 0;

function exportProfile() {
  if (profileCount === 0) return;
  const values = Array.from(profileSum, (s) => Math.round(s / profileCount));
  const blob = new Blob([JSON.stringify({ bins: BINS, values })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${trackSlug}-profile.json`;
  a.click();
  URL.revokeObjectURL(url);
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'p') exportProfile();
});

let profileThreshold = PROFILE_THRESHOLD;
const thresholdEl = document.getElementById('threshold');
const thresholdValEl = document.getElementById('threshold-val');
thresholdEl.value = profileThreshold;
thresholdValEl.textContent = profileThreshold.toFixed(2);
thresholdEl.addEventListener('input', () => {
  profileThreshold = Number(thresholdEl.value);
  thresholdValEl.textContent = profileThreshold.toFixed(2);
});

let frame = 0;

// Spawns exactly one new generation per lane, every SPAWN_INTERVAL frames --
// deterministic slot reuse (no pool search needed, unlike trees.js's sparse
// random placement) since every lane spawns in lockstep.
function spawnGeneration(left, right, scale) {
  const spawnIndex = Math.floor(frame / SPAWN_INTERVAL);
  const genSlot = spawnIndex % GENERATIONS_PER_LANE;
  profileCount++;
  for (let lane = 0; lane < TOTAL_LANES; lane++) {
    const channel = lane < LANES_PER_CHANNEL ? 0 : 1;
    const laneIndexInChannel = channel === 0 ? lane : lane - LANES_PER_CHANNEL;
    const bin = laneIndexInChannel * BIN_STRIDE;
    const rawByte = (channel === 0 ? left[bin] : right[bin]) || 0;
    const scaledByte = Math.min(255, Math.round(rawByte * scale));
    profileSum[bin] += scaledByte;

    const slotIndex = lane * GENERATIONS_PER_LANE + genSlot;
    const slot = slots[slotIndex];
    let passesGate = true;
    if (hasProfile) {
      const avg = Math.max(profileValues[bin], 2);
      passesGate = scaledByte / avg >= profileThreshold;
    }
    slot.active = passesGate;
    slot.height = Math.max((scaledByte / 255) * AMPLITUDE, 0.15);
    slot.spawnFrame = frame;
    slot.worldX = laneWorldX(laneIndexInChannel, channel);
  }
}

// Repositions every live building along its own straight path from the far
// edge to the camera -- exactly trees.js's own update(): spawned at frame F,
// at the far edge right away, reaching the near edge CROSSING_FRAMES frames
// later, then retired.
function updateInstances() {
  for (let i = 0; i < MAX_INSTANCES; i++) {
    const slot = slots[i];
    const age = frame - slot.spawnFrame;
    if (!slot.active || age < 0 || age >= CROSSING_FRAMES) {
      hideInstance(i);
      continue;
    }
    const worldZ = DEPTH * (age / CROSSING_FRAMES - 0.5);
    dummy.position.set(slot.worldX, 0, worldZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, slot.height, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// setInterval, not requestAnimationFrame: this tool doubles as an unattended
// profile-capture rig (see exportProfile/the 'p' key), often left running in
// a background/hidden browser tab for a whole track's length -- rAF fully
// stops in a hidden tab (no throttling, it just never fires again), which
// silently froze frame/profileSum at 0 for the entire capture. setInterval
// only gets throttled to ~1/s when hidden, so the profile keeps accumulating
// (just coarser) instead of not accumulating at all.
function animate() {
  if (analyser.isPlaying) {
    const { left, right } = analyser.getFrequencyData();

    let frameMax = 0;
    for (let i = 0; i < BINS; i++) {
      if (left[i] > frameMax) frameMax = left[i];
      if (right[i] > frameMax) frameMax = right[i];
    }
    envelope = Math.max(frameMax, envelope * ENVELOPE_RELEASE, ENVELOPE_FLOOR);
    const scale = 255 / envelope;

    if (frame % SPAWN_INTERVAL === 0) {
      spawnGeneration(left, right, scale);
    }
    updateInstances();
    frame++;
  }

  controls.update();
  renderer.render(scene, camera);
}
setInterval(animate, 16);

window.__debug = {
  mesh, renderer, scene, camera, analyser, slots,
  get frame() { return frame; },
};
