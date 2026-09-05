import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AudioAnalyser } from './audio.js';
import { Terrain } from './terrain.js';
import { tracks, trackBySlug, renderGlyphTitle, DEFAULT_VISIBLE_SLUGS } from './album.js';

const scene = new THREE.Scene();

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
const DEFAULT_HUE = 0;
const DEFAULT_SATURATION = 0;
const DEFAULT_BRILLIANCE = 0;
const DEFAULT_FOG = 0;
const DEFAULT_VIBRATION = 0;

const terrain = new Terrain({
  width: computeTerrainWidth(),
  amplitude: DEFAULT_AMPLITUDE,
  fog: DEFAULT_FOG,
});
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

// Which tracks show in the top row and get chained into -- toggled from the
// "morceaux affichés" checkboxes in the tuning panel. All tracks still exist
// (trackBySlug/deep links keep working regardless), this only controls what
// gets built into the tracklist row and what nextTrackOf() cycles through.
let visibleSlugs = new Set(DEFAULT_VISIBLE_SLUGS);

function visibleTracks() {
  return tracks.filter((t) => visibleSlugs.has(t.slug));
}

function buildTracklist() {
  tracklistEl.innerHTML = '';
  visibleTracks().forEach((track) => {
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

const tuningAutochain = document.getElementById('tuning-autochain');

// Only among the currently visible tracks (see visibleSlugs above) -- wraps
// to itself if just one is shown.
function nextTrackOf(slug) {
  const list = visibleTracks();
  const index = list.findIndex((t) => t.slug === slug);
  return list[(index + 1) % list.length];
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
  if (tuningAutochain.checked && currentSlug && analyser.remaining < QUEUE_AHEAD) {
    queueFollowing(currentSlug);
  }
}, 1000);

// The queued track has already taken over the sound, sample-accurately;
// there is nothing to start here, only the display to bring up to date.
analyser.onAdvance = () => {
  showTrack(nextTrackOf(currentSlug), { pushHash: true });
};

// Reached when nothing was queued in time (chaining just turned on, a failed
// fetch, or a track shorter than QUEUE_AHEAD) -- or simply when "enchaînement
// automatique" is off, in which case a track plays once and stops here.
analyser.onEnded = () => {
  if (tuningAutochain.checked) {
    selectTrack(nextTrackOf(currentSlug).slug, { pushHash: true });
  } else {
    resetToIdle({ clearHash: true });
  }
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
const tuningHue = document.getElementById('tuning-hue');
const tuningHueVal = document.getElementById('tuning-hue-val');
const tuningHueLink = document.getElementById('tuning-hue-link');
const tuningSaturation = document.getElementById('tuning-saturation');
const tuningSaturationVal = document.getElementById('tuning-saturation-val');
const tuningSaturationLink = document.getElementById('tuning-saturation-link');
const tuningBrilliance = document.getElementById('tuning-brilliance');
const tuningBrillianceVal = document.getElementById('tuning-brilliance-val');
const tuningBrillianceLink = document.getElementById('tuning-brilliance-link');
const tuningFog = document.getElementById('tuning-fog');
const tuningFogVal = document.getElementById('tuning-fog-val');
const tuningBackdropLink = document.getElementById('tuning-backdrop-link');
const backdropEl = document.getElementById('backdrop');
const tuningVibration = document.getElementById('tuning-vibration');
const tuningVibrationVal = document.getElementById('tuning-vibration-val');

tuningWidth.value = computeTerrainWidth();
tuningWidthVal.textContent = Number(tuningWidth.value).toFixed(0);
tuningAmplitude.value = DEFAULT_AMPLITUDE;
tuningAmplitudeVal.textContent = Number(tuningAmplitude.value).toFixed(1);
tuningCurve.value = DEFAULT_CURVE;
tuningCurveVal.textContent = Number(tuningCurve.value).toFixed(1);
tuningHue.value = DEFAULT_HUE;
tuningHueVal.textContent = Number(tuningHue.value).toFixed(2);
tuningSaturation.value = DEFAULT_SATURATION;
tuningSaturationVal.textContent = Number(tuningSaturation.value).toFixed(2);
tuningBrilliance.value = DEFAULT_BRILLIANCE;
tuningBrillianceVal.textContent = Number(tuningBrilliance.value).toFixed(2);
tuningFog.value = DEFAULT_FOG;
tuningFogVal.textContent = Number(tuningFog.value).toFixed(2);
tuningVibration.value = DEFAULT_VIBRATION;
tuningVibrationVal.textContent = Number(tuningVibration.value).toFixed(2);

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
tuningHue.addEventListener('input', () => {
  const v = Number(tuningHue.value);
  tuningHueVal.textContent = v.toFixed(2);
  terrain.setHueShift(v);
});
tuningSaturation.addEventListener('input', () => {
  const v = Number(tuningSaturation.value);
  tuningSaturationVal.textContent = v.toFixed(2);
  terrain.setSaturation(v);
});
tuningBrilliance.addEventListener('input', () => {
  const v = Number(tuningBrilliance.value);
  tuningBrillianceVal.textContent = v.toFixed(2);
  terrain.setBrilliance(v);
});
tuningFog.addEventListener('input', () => {
  const v = Number(tuningFog.value);
  tuningFogVal.textContent = v.toFixed(2);
  terrain.setFog(v);
});
tuningVibration.addEventListener('input', () => {
  const v = Number(tuningVibration.value);
  tuningVibrationVal.textContent = v.toFixed(2);
  terrain.setVibration(v);
});

// Each of the three new looks can instead be slaved to one of the existing
// knobs, min-to-min and max-to-max (green at courbe's most negative bend,
// blue at its most positive one; and so on) rather than driven by hand.
// While linked, its own slider is disabled and repainted from the source
// every frame in applyLinkedLooks() below, so it still reflects the live
// value whether that source is being dragged or auto-drifting.
function setLinked(input, linked) {
  input.disabled = linked;
}
tuningHueLink.addEventListener('change', () => setLinked(tuningHue, tuningHueLink.checked));
tuningSaturationLink.addEventListener('change', () => setLinked(tuningSaturation, tuningSaturationLink.checked));
tuningBrillianceLink.addEventListener('change', () => setLinked(tuningBrilliance, tuningBrillianceLink.checked));
// The three link checkboxes default to checked (see index.html), which fires
// no 'change' event on load, so the sliders' disabled state has to be synced
// by hand here once.
setLinked(tuningHue, tuningHueLink.checked);
setLinked(tuningSaturation, tuningSaturationLink.checked);
setLinked(tuningBrilliance, tuningBrillianceLink.checked);

function applyLinkedLooks() {
  if (tuningHueLink.checked) {
    // Curve and coloration are both signed ranges centred on 0 ("as
    // authored"), so this is a direct proportional mapping.
    const v = Number(tuningCurve.value) / Number(tuningCurve.max);
    tuningHue.value = v;
    tuningHueVal.textContent = v.toFixed(2);
    terrain.setHueShift(v);
  }
  if (tuningSaturationLink.checked) {
    // Inverted on purpose: narrow -> vivid, wide -> black & white.
    const min = Number(tuningWidth.min);
    const max = Number(tuningWidth.max);
    const v = 1 - 2 * ((Number(tuningWidth.value) - min) / (max - min));
    tuningSaturation.value = v;
    tuningSaturationVal.textContent = v.toFixed(2);
    terrain.setSaturation(v);
  }
  if (tuningBrillianceLink.checked) {
    const min = Number(tuningAmplitude.min);
    const max = Number(tuningAmplitude.max);
    const v = -1 + 2 * ((Number(tuningAmplitude.value) - min) / (max - min));
    tuningBrilliance.value = v;
    tuningBrillianceVal.textContent = v.toFixed(2);
    terrain.setBrilliance(v);
  }
}

// The backdrop is a plain CSS background image, not part of the terrain's
// shader, so the same three values are approximated with CSS filters instead
// of the shader's own hue/saturation/brilliance maths -- close enough to read
// as the same effect, not a pixel-identical match.
function updateBackdropFilter() {
  if (!tuningBackdropLink.checked) {
    backdropEl.style.filter = '';
    return;
  }
  const hue = Number(tuningHue.value);
  const sat = Number(tuningSaturation.value);
  const brilliance = Number(tuningBrilliance.value);
  // hue-rotate sweeps one continuous ring, so green and blue sit at
  // different distances from this image's native red/orange -- tuned by eye
  // rather than derived, unlike the courbe/largeur/hauteur link maths above.
  const hueDeg = hue < 0 ? hue * -100 : hue * -140;
  const satPct = sat < 0 ? (1 + sat) * 100 : 100 + sat * 100;
  const glow = Math.max(-brilliance, 0);
  const chrome = Math.max(brilliance, 0);
  const brightnessPct = 100 + glow * 18;
  const contrastPct = 100 + chrome * 20 - glow * 8;
  backdropEl.style.filter =
    `hue-rotate(${hueDeg.toFixed(1)}deg) saturate(${satPct.toFixed(0)}%) ` +
    `brightness(${brightnessPct.toFixed(0)}%) contrast(${contrastPct.toFixed(0)}%)`;
}
tuningBackdropLink.addEventListener('change', updateBackdropFilter);

// "Réglages automatiques": each slider drifts on its own toward a fresh
// random target and picks a new one on arrival, so the terrain keeps
// reshaping itself with nobody at the panel. Each parameter gets its own
// travel time so the three never move in lockstep; the speed slider scales
// all of them at once.
const autoToggle = document.getElementById('tuning-auto');
const autoSpeed = document.getElementById('tuning-auto-speed');
const autoSpeedVal = document.getElementById('tuning-auto-speed-val');

// Coloration/saturation/brillance stay out of this drift entirely -- with
// "réglages automatiques" on by default, a drifting slider fights any manual
// drag every frame and the drag never sticks. They're either linked (driven
// live by applyLinkedLooks() from their source knob) or fully manual, with
// no third autonomous state of their own.
const autoParams = [
  { input: tuningWidth, valEl: tuningWidthVal, digits: 0, apply: (v) => terrain.setWidth(v) },
  { input: tuningAmplitude, valEl: tuningAmplitudeVal, digits: 1, apply: (v) => terrain.setAmplitude(v) },
  { input: tuningCurve, valEl: tuningCurveVal, digits: 1, apply: (v) => terrain.setCurve(v) },
  { input: tuningFog, valEl: tuningFogVal, digits: 2, apply: (v) => terrain.setFog(v) },
  { input: tuningVibration, valEl: tuningVibrationVal, digits: 2, apply: (v) => terrain.setVibration(v) },
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
    if (p.linked && p.linked()) continue;
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

// One checkbox per track in the tuning panel, independent of the tracklist
// row itself: toggling one adds/removes that slug from visibleSlugs and
// rebuilds the row. Always keeps at least one track visible -- an empty row
// would leave nextTrackOf() with nothing to cycle through.
const tuningTracksGroup = document.getElementById('tuning-tracks-group');
tracks.forEach((track) => {
  const label = document.createElement('label');
  label.className = 'check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.autocomplete = 'off';
  checkbox.checked = visibleSlugs.has(track.slug);
  checkbox.addEventListener('change', () => {
    if (!checkbox.checked && visibleSlugs.size <= 1 && visibleSlugs.has(track.slug)) {
      checkbox.checked = true; // refuse to hide the last visible track
      return;
    }
    if (checkbox.checked) visibleSlugs.add(track.slug);
    else visibleSlugs.delete(track.slug);
    buildTracklist();
  });
  const span = document.createElement('span');
  span.textContent = track.title;
  label.appendChild(checkbox);
  label.appendChild(span);
  tuningTracksGroup.appendChild(label);
});

buildTracklist();

const initialSlug = location.hash.replace('#', '');
if (initialSlug && trackBySlug(initialSlug)) {
  selectTrack(initialSlug);
}

// Past their own midpoint, courbe and hauteur both raise the terrain's edges
// or peaks toward the camera's eye-line -- courbe by curling the near/far
// edges upward (see uCurve in the vertex shader), hauteur simply by making
// taller peaks. Past a point either one risks poking above the camera and
// exposing the mesh's flat, cut-off boundary instead of reading as an
// unbounded terrain. Craning the camera up (zenith) keeps looking steeply
// enough down to hide that edge -- applied as a frame-to-frame delta, never
// an absolute reset, so it stacks with the user's own OrbitControls drag
// instead of fighting it, and the OrbitControls target (the focus point)
// never moves, only the camera's height.
const CURVE_LIFT_MAX = 10;
const AMPLITUDE_LIFT_MAX = 8;
let lastZenithLift = 0;

function zenithLiftFor(curve, amplitude) {
  const curveMax = Number(tuningCurve.max);
  const curveLift = (Math.max(curve, 0) / curveMax) * CURVE_LIFT_MAX;

  const ampMax = Number(tuningAmplitude.max);
  const ampMid = ampMax / 2;
  const amplitudeLift = (Math.max(amplitude - ampMid, 0) / (ampMax - ampMid)) * AMPLITUDE_LIFT_MAX;

  return curveLift + amplitudeLift;
}

function applyZenithLift() {
  const lift = zenithLiftFor(Number(tuningCurve.value), Number(tuningAmplitude.value));
  camera.position.y += lift - lastZenithLift;
  lastZenithLift = lift;
}

// Two 0..1 loudness figures for the vibration effect below, both read from
// the same per-frame frequency data terrain.update() already fetches rather
// than tapping the analyser again.
//
// currentLevelFrom is the broadband mean -- moves smoothly, good for "mou"'s
// slow wave. currentBassFrom keeps only the lowest bands, covering roughly
// 30-200Hz (bins are log-spaced from 30Hz, see audio.js): a kick's
// fundamental usually sits at 50-90Hz with its attack/click extending up
// towards 200-300Hz, so this reaches past just the sub-bass sliver that a
// narrower band would miss, while stopping short of the bassline's own
// melodic range further up.
function currentLevelFrom(freq) {
  let sum = 0;
  const n = freq.left.length;
  for (let i = 0; i < n; i++) sum += freq.left[i] + freq.right[i];
  return sum / (n * 2 * 255);
}
const BASS_CUTOFF_HZ = 200;
// Only called once analyser.isPlaying, by which point the real sample rate
// (and so the exact bin count for 200Hz) is known -- see binsUpTo().
function currentBassFrom(freq) {
  const bassBins = analyser.binsUpTo(BASS_CUTOFF_HZ);
  let sum = 0;
  for (let i = 0; i < bassBins; i++) sum += freq.left[i] + freq.right[i];
  return sum / (bassBins * 2 * 255);
}

// Spectral centroid: the energy-weighted average bin index, 0..1 from the
// lowest band to the highest. Not how loud the sound is (that's the two
// figures above) but *where* it sits in the spectrum right now -- this is
// what ties the ripple's own wavelength to the music, independently of
// "mou"/"dur": a bass-heavy instant (centroid near 0) should ripple wide,
// a treble-heavy one (centroid near 1) should ripple tight, regardless of
// which side of the slider is driving its amplitude.
function spectralCentroidFrom(freq) {
  let weighted = 0;
  let total = 0;
  const n = freq.left.length;
  for (let i = 0; i < n; i++) {
    const mag = freq.left[i] + freq.right[i];
    weighted += mag * i;
    total += mag;
  }
  return total > 0 ? weighted / total / (n - 1) : 0;
}

// Vibration lives in the terrain's own geometry (see uVibration in the
// vertex shader), not as a CSS effect on the page: it needs to read as the
// sound's own flow rippling through the surface, not the whole screen (art
// included) shaking. Both levels settle back to 0 on their own in silence,
// even if the slider stays dialled in, so terrain.updateVibration() drives
// the ripple's strength every frame.
let vibrationLevel = 0;
let vibrationBassAvg = 0; // slow-tracking average, only used to detect attacks (see below)
let vibrationCentroid = 0.5; // smoothed spectral centroid, see spectralCentroidFrom()

// "Dur" is a struck spring, not a value that jumps straight to a target: an
// attack gives it a push (adds to its velocity) and it settles back to rest
// under its own stiffness/damping, the way a hit object actually would --
// smooth and continuous with no slope discontinuity at the moment of the
// hit, unlike snapping an envelope value toward a target every frame.
let bassSpringPos = 0;
let bassSpringVel = 0;
const BASS_SPRING_STIFFNESS = 140;
const BASS_SPRING_DAMPING = 16;

let lastFrameTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // clamp: tab-switch gaps
  lastFrameTime = now;
  updateAutoTuning(dt);
  applyLinkedLooks();
  updateBackdropFilter();
  applyZenithLift();

  if (analyser.isPlaying) {
    const freq = analyser.getFrequencyData();
    terrain.update(freq);
    vibrationLevel += (currentLevelFrom(freq) - vibrationLevel) * Math.min(1, dt * 10);
    // Attack detector: track a slow-moving average of the bass band, then
    // take how far *above* that average the current instant is. A sustained
    // bassline sits close to its own average and produces almost nothing; a
    // kick jumps above it and produces a spike -- so "dur" reacts to the
    // attacks specifically, rather than to bass loudness in general.
    const bassNow = currentBassFrom(freq);
    vibrationBassAvg += (bassNow - vibrationBassAvg) * Math.min(1, dt * 3);
    const drive = Math.max(0, bassNow - vibrationBassAvg) * 4;
    bassSpringVel += drive * BASS_SPRING_STIFFNESS * dt;
    vibrationCentroid += (spectralCentroidFrom(freq) - vibrationCentroid) * Math.min(1, dt * 6);
  } else {
    vibrationLevel += (0 - vibrationLevel) * Math.min(1, dt * 4);
  }
  // Spring-damper integration runs every frame regardless of playback state,
  // so a struck spring still rings down to rest instead of freezing mid-swing
  // the instant the track stops.
  const springForce = -BASS_SPRING_STIFFNESS * bassSpringPos - BASS_SPRING_DAMPING * bassSpringVel;
  bassSpringVel += springForce * dt;
  bassSpringPos += bassSpringVel * dt;
  const vibrationBass = Math.max(0, Math.min(1, bassSpringPos));
  // Below 1 widens the ripple's wavelength (bass-heavy), above 1 tightens it
  // (treble-heavy) -- multiplies the shader's own base spatial frequencies,
  // see uVibrationSpatial in the vertex shader.
  const vibrationSpatial = 0.4 + vibrationCentroid * 2.1;
  terrain.updateVibration(dt, vibrationLevel, vibrationBass, vibrationSpatial);

  controls.update();
  renderer.render(scene, camera);
}

animate();
