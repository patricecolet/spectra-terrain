import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AudioAnalyser } from './audio.js';
import { Terrain } from './terrain.js';
import { tracks, trackBySlug, renderGlyphTitle } from './album.js';

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070d, 0.025);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 26, 34);
camera.lookAt(0, 0, 0);

// Alpha-transparent renderer: the terrain floats directly over the album
// artwork (set as a CSS background on #backdrop) instead of a solid colour.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

// Spread the spectrum across as much of the viewport's width as makes sense
// for its shape: wide/landscape screens get a wider ground plane so bass
// through treble spread out more, narrow/portrait ones stay proportionally
// narrower instead of overflowing off-screen.
function computeTerrainWidth() {
  const aspect = window.innerWidth / window.innerHeight;
  return THREE.MathUtils.clamp(aspect * 21, 18, 46);
}

const DEFAULT_AMPLITUDE = 5;
const DEFAULT_CURVE = 0;

const terrain = new Terrain({ width: computeTerrainWidth(), amplitude: DEFAULT_AMPLITUDE });
scene.add(terrain.mesh);
let manualWidth = false;

const analyser = new AudioAnalyser(terrain.bins);

const viewToggle = document.getElementById('view-toggle');
const animToggle = document.getElementById('anim-toggle');
const stopBtn = document.getElementById('stop-btn');
const tracklistEl = document.getElementById('tracklist');
const centerStage = document.getElementById('center-stage');
const nowPlaying = document.getElementById('now-playing');
const nowPlayingTitle = document.getElementById('now-playing-title');
const bigLogo = document.getElementById('big-logo');
const topLogo = document.getElementById('logo');

let currentSlug = null;
let pendingSlug = null; // armed by a deep link, waiting for a user gesture
let hasStartedPlayback = false;
let animVisible = true;

function updateCanvasVisibility() {
  renderer.domElement.classList.toggle('active', hasStartedPlayback && animVisible);
}

function buildTracklist() {
  tracks.forEach((track) => {
    const btn = document.createElement('button');
    btn.className = 'track-btn';
    btn.dataset.slug = track.slug;
    const row = document.createElement('div');
    renderGlyphTitle(row, track.title, 16);
    btn.appendChild(row);
    btn.addEventListener('click', () => playTrack(track.slug, { pushHash: true }));
    tracklistEl.appendChild(btn);
  });
}

function setActiveButton(slug) {
  tracklistEl.querySelectorAll('.track-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.slug === slug);
  });
}

// The terrain only ever shows real sound: it stays hidden (cover art only)
// until playback has actually started, and returns to hidden the moment
// nothing is playing, rather than lingering on a flat/frozen shape.
function resetToIdle({ clearHash = false } = {}) {
  currentSlug = null;
  pendingSlug = null;
  setActiveButton(null);
  nowPlaying.classList.remove('visible');
  centerStage.classList.remove('hidden');
  hasStartedPlayback = false;
  updateCanvasVisibility();
  if (clearHash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function stopPlayback() {
  analyser.stop();
  resetToIdle({ clearHash: true });
}

// The album plays through on its own and wraps around to the first track,
// so the page can be left running; only "stop" ever returns it to idle.
function nextTrackOf(slug) {
  const index = tracks.findIndex((t) => t.slug === slug);
  return tracks[(index + 1) % tracks.length];
}

// How many seconds before the end of a track its successor gets decoded and
// scheduled. Early enough that a slow connection still makes it in time,
// late enough that two decoded tracks (~100 MB of PCM each) only overlap in
// memory for a moment instead of for the whole album.
const QUEUE_AHEAD = 20;

function queueFollowing(slug) {
  analyser.queueNext(nextTrackOf(slug).file).catch((err) => console.error('enchaînement', err));
}

// Deliberately a timer and not the render loop: requestAnimationFrame stops
// dead as soon as the tab goes to the background, which is precisely when
// someone is listening to the album without watching it — the next track
// would never get queued and the gap would come back. Chrome exempts
// audible tabs from timer freezing, so a plain interval keeps running.
setInterval(() => {
  if (currentSlug && analyser.remaining < QUEUE_AHEAD) queueFollowing(currentSlug);
}, 1000);

// The queued track has already taken over the sound, sample-accurately;
// there is nothing to start here, only the display to bring up to date.
analyser.onAdvance = () => {
  showTrack(nextTrackOf(currentSlug), { pushHash: true });
};

// Safety net: reached only when nothing was queued in time (a failed fetch,
// or a track shorter than QUEUE_AHEAD). Audible gap, but the album goes on.
analyser.onEnded = () => {
  selectTrack(nextTrackOf(currentSlug).slug, { pushHash: true });
};

// A page opened on #slug has seen no user gesture, so the audio context
// cannot start (see AudioAnalyser.canStart). Arm the track silently — the
// page just stays on its cover, with the track's button lit — decode it in
// the background, and let the first click or keypress anywhere start it.
// No overlay, no "click to play" prompt.
function armTrack(slug) {
  const track = trackBySlug(slug);
  if (!track) return;
  pendingSlug = slug;
  setActiveButton(slug);
  analyser.prepare(track.file).catch((err) => console.error('préchargement', err));
}

// Every start that originates in a user gesture goes through here: resuming
// the audio context is only permitted from inside the gesture itself, and
// selectTrack's own canStart() check would still see a suspended context.
async function playTrack(slug, opts) {
  await analyser.unlock();
  selectTrack(slug, opts);
}

// Controls that already do something on click must not double as the "start
// the armed track" gesture.
const OWN_HANDLER = '.track-btn, #tuning, #tuning-toggle, #now-playing';

function startPending(event) {
  if (!pendingSlug) return;
  if (event && event.target && event.target.closest && event.target.closest(OWN_HANDLER)) return;
  const slug = pendingSlug;
  pendingSlug = null;
  playTrack(slug);
}
window.addEventListener('pointerdown', startPending);
window.addEventListener('keydown', startPending);

async function selectTrack(slug, { pushHash = false } = {}) {
  const track = trackBySlug(slug);
  if (!track) return;

  if (pushHash) {
    history.replaceState(null, '', `#${slug}`);
  }

  // Nothing may claim to be playing before the sound can actually start.
  if (!analyser.canStart()) {
    armTrack(slug);
    return;
  }

  showTrack(track, { pushHash: false });

  try {
    await analyser.loadURL(track.file);
    hasStartedPlayback = true;
    updateCanvasVisibility();
  } catch (err) {
    console.error('erreur de lecture', err);
    resetToIdle();
  }
}

// Everything that says "this track is the one playing", with no audio side
// effect — so a seamless handover can update the page without touching the
// sound that is already running.
function showTrack(track, { pushHash = false } = {}) {
  currentSlug = track.slug;
  pendingSlug = null;
  setActiveButton(track.slug);
  renderGlyphTitle(nowPlayingTitle, track.title, 24);
  nowPlaying.classList.add('visible');
  centerStage.classList.add('hidden');
  if (pushHash) {
    history.replaceState(null, '', `#${track.slug}`);
  }
}

function goToCover() {
  centerStage.classList.remove('hidden');
}
bigLogo.addEventListener('click', goToCover);
topLogo.addEventListener('click', goToCover);

viewToggle.addEventListener('click', () => {
  const bassCenter = terrain.toggleBassCenter();
  viewToggle.textContent = bassCenter ? 'vue : basses au milieu' : 'vue : vallée au milieu';
});

stopBtn.addEventListener('click', stopPlayback);

// Hides the 3D visual only -- playback keeps going, just without the terrain
// (e.g. to look at the artwork itself while listening).
animToggle.addEventListener('click', () => {
  animVisible = !animVisible;
  animToggle.textContent = animVisible ? "masquer l'animation" : "afficher l'animation";
  updateCanvasVisibility();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (!manualWidth) terrain.setWidth(computeTerrainWidth());
});

// Live tuning panel: width, height (amplitude) and the depth-axis curve are
// all experimental knobs for now, wired straight to the terrain.
const tuningWidth = document.getElementById('tuning-width');
const tuningWidthVal = document.getElementById('tuning-width-val');
const tuningAmplitude = document.getElementById('tuning-amplitude');
const tuningAmplitudeVal = document.getElementById('tuning-amplitude-val');
const tuningCurve = document.getElementById('tuning-curve');
const tuningCurveVal = document.getElementById('tuning-curve-val');

tuningWidth.value = computeTerrainWidth();
tuningWidthVal.textContent = Number(tuningWidth.value).toFixed(0);
tuningAmplitude.value = DEFAULT_AMPLITUDE;
tuningAmplitudeVal.textContent = Number(tuningAmplitude.value).toFixed(1);
tuningCurve.value = DEFAULT_CURVE;
tuningCurveVal.textContent = Number(tuningCurve.value).toFixed(1);

tuningWidth.addEventListener('input', () => {
  manualWidth = true;
  const v = Number(tuningWidth.value);
  tuningWidthVal.textContent = v.toFixed(0);
  terrain.setWidth(v);
});
tuningAmplitude.addEventListener('input', () => {
  const v = Number(tuningAmplitude.value);
  tuningAmplitudeVal.textContent = v.toFixed(1);
  terrain.setAmplitude(v);
});
tuningCurve.addEventListener('input', () => {
  const v = Number(tuningCurve.value);
  tuningCurveVal.textContent = v.toFixed(1);
  terrain.setCurve(v);
});

// "Réglages automatiques": each slider drifts on its own toward a fresh
// random target and picks a new one on arrival, so the terrain keeps
// reshaping itself with nobody at the panel. Each parameter gets its own
// travel time so the three never move in lockstep; the speed slider scales
// all of them at once.
const autoToggle = document.getElementById('tuning-auto');
const autoSpeed = document.getElementById('tuning-auto-speed');
const autoSpeedVal = document.getElementById('tuning-auto-speed-val');

const autoParams = [
  { input: tuningWidth, valEl: tuningWidthVal, digits: 0, apply: (v) => terrain.setWidth(v) },
  { input: tuningAmplitude, valEl: tuningAmplitudeVal, digits: 1, apply: (v) => terrain.setAmplitude(v) },
  { input: tuningCurve, valEl: tuningCurveVal, digits: 1, apply: (v) => terrain.setCurve(v) },
];

// Targets stay off the very ends of each slider: an amplitude of 0 flattens
// the terrain to nothing and a curve at full tilt folds it away, which is a
// dead picture rather than a variation.
const DRIFT_MARGIN = 0.15;

function retarget(p) {
  const min = Number(p.input.min);
  const max = Number(p.input.max);
  const span = max - min;
  p.target = min + span * (DRIFT_MARGIN + Math.random() * (1 - 2 * DRIFT_MARGIN));
  p.seconds = 4 + Math.random() * 8;
}

function resyncAuto() {
  autoParams.forEach((p) => {
    p.value = Number(p.input.value);
    retarget(p);
  });
}
resyncAuto();

// A range input snaps any assigned value to its step, so under a perfectly
// smooth terrain the thumb would still tick along in whole units. Drop the
// step while the drift runs, put it back for hand adjustment.
autoParams.forEach((p) => { p.baseStep = p.input.step; });
function setAutoStep(on) {
  autoParams.forEach((p) => { p.input.step = on ? 'any' : p.baseStep; });
}
setAutoStep(autoToggle.checked); // on by default, see index.html

autoSpeedVal.textContent = `×${Number(autoSpeed.value).toFixed(1)}`;
autoSpeed.addEventListener('input', () => {
  autoSpeedVal.textContent = `×${Number(autoSpeed.value).toFixed(1)}`;
});
// Restart from wherever the sliders stand now, not from a stale position
// left over from the last time the drift was running.
autoToggle.addEventListener('change', () => {
  setAutoStep(autoToggle.checked);
  if (autoToggle.checked) resyncAuto();
});

function updateAutoTuning(dt) {
  if (!autoToggle.checked) return;
  manualWidth = true; // the drift owns the width; resize must not snatch it back
  const speed = Number(autoSpeed.value);
  for (const p of autoParams) {
    const span = Number(p.input.max) - Number(p.input.min);
    // Exponential approach: leaves briskly, eases into the target.
    p.value += (p.target - p.value) * (1 - Math.exp((-dt * speed * 3) / p.seconds));
    if (Math.abs(p.target - p.value) < span * 0.01) retarget(p);
    // Applied continuously — only the panel's readout is rounded.
    p.input.value = p.value;
    p.valEl.textContent = p.value.toFixed(p.digits);
    p.apply(p.value);
  }
}

const tuningPanel = document.getElementById('tuning');
const tuningToggle = document.getElementById('tuning-toggle');
tuningToggle.addEventListener('click', () => {
  tuningPanel.classList.toggle('hidden');
});

const styleButtons = document.querySelectorAll('.style-btn');
styleButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    styleButtons.forEach((b) => b.classList.toggle('active', b === btn));
    terrain.setStyle(Number(btn.dataset.style));
  });
});
// The drawn texture is the album's own look, so it is what the page opens on.
const DEFAULT_STYLE = 1;
const defaultStyleBtn = document.querySelector(`.style-btn[data-style="${DEFAULT_STYLE}"]`);
defaultStyleBtn.classList.add('active');
terrain.setStyle(DEFAULT_STYLE);

window.addEventListener('hashchange', () => {
  const slug = location.hash.replace('#', '');
  if (slug && slug !== currentSlug) {
    selectTrack(slug);
  }
});

buildTracklist();

const initialSlug = location.hash.replace('#', '');
if (initialSlug && trackBySlug(initialSlug)) {
  selectTrack(initialSlug);
}

let lastFrameTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // clamp: tab-switch gaps
  lastFrameTime = now;
  updateAutoTuning(dt);

  if (analyser.isPlaying) {
    const freq = analyser.getFrequencyData();
    terrain.update(freq);
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
