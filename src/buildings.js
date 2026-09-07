import * as THREE from 'three';

// A "buildings" alternative to the rock terrain: real instanced boxes that
// spawn at the far edge with a height fixed once and for all at birth, then
// physically travel toward the camera over a fixed lifetime, retiring on
// arrival -- exactly trees.js's own model (see its own header comment for
// why a raymarched SDF grid was tried and dropped: many independently
// moving objects don't fit a per-pixel marching loop, but they're exactly
// what instancing is for).
//
// Shares the host app's camera/scene/analyser -- this only owns its own
// mesh, spawn bookkeeping and (optional, per-track) profile-gate data.

const DEFAULT_AMPLITUDE = 6;
const BASE_COLOR = new THREE.Color(0x8fa8c9);
// Same falloff/cap as terrain.frag.glsl's own MAX_FOG_DENSITY -- kept in
// step so "brouillard" reads as the same amount of atmosphere in both views.
const MAX_FOG_DENSITY = 0.025;
// A fresh generation is spawned per lane every this-many rendered frames --
// purely a spatial/density knob (how many buildings fit along one lane's
// length), not an averaging window: each generation's height is a single raw
// sample taken once at spawn, never touched again. Averaging only ever
// happens offline, once, to build the per-bin profile JSON (see
// buildings-test.js's exportProfile) -- never to the live per-frame data.
const SPAWN_INTERVAL = 4;
const LANES_PER_CHANNEL = 32; // sampled from bins at a stride, like a coarser skyline
const DEFAULT_PROFILE_THRESHOLD = 1.0;
const DEFAULT_AMPLITUDE_COLOR = 1.0;
// "Ilots" (city blocks): every spawn tick, this many randomly-placed runs of
// neighbouring lanes (within the same channel) merge into one wider building
// instead of each lane getting its own -- see setClusterCount/setMaxClusterSize.
const DEFAULT_CLUSTER_COUNT = 10;
const DEFAULT_MAX_CLUSTER_SIZE = 8;
// Buildings travel a deeper stretch than the rock terrain's own depth, at
// the same speed -- see the constructor's this.depth/this.crossingFrames --
// so retirement happens off-frame (perspective-compressed near the horizon)
// rather than visibly popping out mid-view. At 2x, that "extra" stretch was
// long enough that a building spent a very long final stretch of its life
// barely moving in screen space before finally retiring, reading as stuck
// rather than as a fade -- 1.3x keeps the same off-frame idea with a much
// shorter, less noticeable tail.
const DEPTH_MULTIPLIER = 1.3;
// Envelope-normalized amplitude clusters near the top of its own range far
// more often than it sits low (a mastered track's bins are frequently close
// to the current peak, not just spiking rarely) -- read straight through,
// that means most buildings sit near max height and land on the ramp's
// brightest/yellow stop, with barely any visual spread. Raising the
// normalized value to a power > 1 pushes everything but genuine peaks back
// down, so only real standout moments reach the top and typical ones spread
// across the lower-to-mid range instead of bunching at it. Height and colour
// are two separate concerns needing their own curve: height's is
// live-tunable (see setAmplitudeGamma, defaulting to the slider's own
// max -- see main.js) since how aggressively to push it depends on the
// track's own dynamics; colour's stays fixed at the value that was actually
// tuned by eye against the ember ramp, so dialling in height dynamics never
// warps colour distribution as a side effect (see _spawnGeneration).
const DEFAULT_HEIGHT_GAMMA = 6;
const COLOR_GAMMA = 2.5;

// Same ember ramp terrain.frag.glsl uses (measured from the album artwork),
// reused here so a building's own colour can progress with its amplitude the
// same way the terrain's surface colour does -- see setAmplitudeColorAmount.
const EMBER_STOPS = [
  [new THREE.Color(0.171, 0.005, 0.009), 0.0, 0.0],
  [new THREE.Color(0.207, 0.028, 0.066), 0.0, 0.10],
  [new THREE.Color(0.475, 0.075, 0.063), 0.10, 0.24],
  [new THREE.Color(0.523, 0.176, 0.247), 0.24, 0.38],
  [new THREE.Color(0.666, 0.265, 0.152), 0.38, 0.52],
  [new THREE.Color(0.710, 0.400, 0.214), 0.52, 0.65],
  [new THREE.Color(0.726, 0.500, 0.234), 0.65, 0.80],
  [new THREE.Color(0.807, 0.802, 0.894), 0.80, 1.0],
];

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function emberColor(h) {
  const color = EMBER_STOPS[0][0].clone();
  for (let i = 1; i < EMBER_STOPS.length; i++) {
    const [stop, lo, hi] = EMBER_STOPS[i];
    color.lerp(stop, smoothstep(lo, hi, h));
  }
  return color;
}

// How many chimneys an ilot this many blocks wide/deep gets, and where on
// its roof (normalized -0.5..0.5 offsets, one array per possible count) --
// a fixed small set of layouts rather than randomizing per building, since
// there are only ever up to MAX_CHIMNEYS_PER_SLOT of them anyway.
const MAX_CHIMNEYS_PER_SLOT = 3;
const CHIMNEY_LAYOUTS = [
  [],
  [[0, 0]],
  [[-0.22, -0.18], [0.22, -0.18]],
  [[-0.25, -0.2], [0.25, -0.2], [0, 0.22]],
];
const CHIMNEY_SIZE = 0.18;
const CHIMNEY_HEIGHT = 0.5;

function chimneyCountFor(widthSpan, depthSpan) {
  const size = Math.max(widthSpan, depthSpan);
  if (size >= 4) return MAX_CHIMNEYS_PER_SLOT;
  if (size > 1) return 1;
  return 0;
}

// A canvas-drawn facade texture: a grid of lit windows, optionally over a
// brick coursing pattern. Kept deliberately simple (a test) -- painted once
// at startup, not regenerated per building, so every instance of a given
// tier (see _tierFor) shares one texture and gets its own colour only from
// the usual per-instance tint.
function makeFacadeTexture({ cols, rows, brick }) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8f8f8a';
  ctx.fillRect(0, 0, size, size);

  if (brick) {
    ctx.strokeStyle = '#5f5f5a';
    ctx.lineWidth = 2;
    const brickRows = 8;
    const brickH = size / brickRows;
    for (let r = 0; r <= brickRows; r++) {
      const y = Math.round(r * brickH);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    const brickW = size / 6;
    for (let r = 0; r < brickRows; r++) {
      const offset = (r % 2) * (brickW / 2);
      for (let x = offset; x < size; x += brickW) {
        ctx.beginPath(); ctx.moveTo(x, r * brickH); ctx.lineTo(x, (r + 1) * brickH); ctx.stroke();
      }
    }
  }

  ctx.fillStyle = '#f4f2e8';
  const cellW = size / cols;
  const cellH = size / rows;
  const marginX = cellW * 0.22;
  const marginY = cellH * 0.28;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(c * cellW + marginX, r * cellH + marginY, cellW - marginX * 2, cellH - marginY * 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export class Buildings {
  constructor({ scene, terrain }) {
    this.terrain = terrain;
    this.binStride = Math.max(1, Math.floor(terrain.bins / LANES_PER_CHANNEL));
    // A crossing twice as long as the rock terrain's own, at the same visual
    // speed: doubling depth and crossing-time together keeps units/frame
    // (the actual scroll speed) unchanged, it just takes a building twice as
    // far and twice as long to get there.
    this.depth = terrain.depth * DEPTH_MULTIPLIER;
    this.crossingFrames = terrain.historyLength * DEPTH_MULTIPLIER;
    this.generationsPerLane = Math.round(this.crossingFrames / SPAWN_INTERVAL);
    this.totalLanes = LANES_PER_CHANNEL * 2; // left + right
    this.maxInstances = this.totalLanes * this.generationsPerLane;
    this.profileThreshold = DEFAULT_PROFILE_THRESHOLD;
    this.hasProfile = false;
    this.profileValues = null;
    this.frame = 0;

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(3, 6, 7);
    this.group = new THREE.Group();
    this.group.add(light);
    this.group.add(new THREE.AmbientLight(0x8fa8c9, 0.4));

    // Captured once so a later terrain.setWidth() can be compared against it
    // to rescale the (otherwise fixed) box geometry live -- see
    // _updateInstances. Mirrors how Terrain itself handles width changes
    // (mesh.scale.x = width / baseWidth) rather than rebuilding geometry.
    this._baseWidth = terrain.width;
    // Kept around (not just a local) so chimneys can be spread across a
    // building's actual footprint in world units -- see _updateInstances.
    this.cellWidth = (terrain.width / 2 / LANES_PER_CHANNEL) * 0.85;
    // Kept around (not just a local) so depth-clustering can offset/scale a
    // merged block's position and Z-extent in the same world units -- see
    // _spawnGeneration/_updateInstances.
    this.cellDepth = (this.depth / this.generationsPerLane) * 0.85;
    const boxGeometry = new THREE.BoxGeometry(this.cellWidth, 1, this.cellDepth);
    boxGeometry.translate(0, 0.5, 0); // pivot at the base, like trees' trunk geometry
    // Transparent + partial opacity, so this integrates with the backdrop
    // the same way the terrain's own shader fades into it, instead of solid
    // opaque boxes sitting flatly on top of the artwork. Scene-wide fog (see
    // main.js, where scene.fog is set) does the same "fade into the distance"
    // job the terrain's own shader-side fog does -- kept out of this class
    // since fog is a scene-level property, not something a mesh owns.
    // Three facade tiers on the building's own SIDE faces only, chosen per
    // building from its own ilot size (see _tierFor): a lone block (1x1)
    // stays a plain flat-coloured box; an ilot wider or deeper than one
    // block gets a window grid; from 4 blocks on either axis, brick coursing
    // joins them, with a sparser window grid (fewer, not more -- a bigger
    // block reads as a block of housing, not a single glass tower). All
    // three stay white so the usual per-instance colour tint (see setColorAt
    // in _spawnGeneration) is the only thing that varies a given box's
    // actual colour -- the texture only modulates it (window/mortar
    // contrast), never overrides it. Roof and floor stay materialPlain even
    // on the windowed/bricked tiers (see the per-face material arrays
    // below) -- a texture there would only ever be seen from directly
    // above/below and reads as a rendering mistake rather than a roof.
    const materialOpts = { flatShading: true };
    this.materialPlain = new THREE.MeshLambertMaterial({ color: 0xffffff, ...materialOpts });
    const windowsTexture = makeFacadeTexture({ cols: 3, rows: 5, brick: false });
    this.materialWindows = new THREE.MeshLambertMaterial({ color: 0xffffff, map: windowsTexture, ...materialOpts });
    const brickedTexture = makeFacadeTexture({ cols: 2, rows: 3, brick: true });
    brickedTexture.repeat.set(2, 1); // ilots this big usually span more than one texture-width worth of wall
    this.materialBricked = new THREE.MeshLambertMaterial({ color: 0xffffff, map: brickedTexture, ...materialOpts });
    // BoxGeometry's own face-group order is [+x, -x, +y, -y, +z, -z] --
    // index 2/3 are top/bottom, the rest are the four side faces.
    const sideMaterials = (sideMaterial) => [sideMaterial, sideMaterial, this.materialPlain, this.materialPlain, sideMaterial, sideMaterial];
    // Chimneys stay a single plain material (so a roof full of them doesn't
    // also sprout a window pattern) but do share the same per-instance
    // amplitude tint, on their own small geometry sized for
    // MAX_CHIMNEYS_PER_SLOT per building slot -- see
    // chimneyCountFor/CHIMNEY_LAYOUTS.
    const chimneyGeometry = new THREE.BoxGeometry(CHIMNEY_SIZE, CHIMNEY_HEIGHT, CHIMNEY_SIZE);
    chimneyGeometry.translate(0, CHIMNEY_HEIGHT / 2, 0);
    this.chimneyMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, ...materialOpts });
    this.hue = 0;
    this.saturation = 0;
    this.brilliance = 0;
    this.fogAmount = 0;
    this.curve = 0;
    this.amplitudeColorAmount = DEFAULT_AMPLITUDE_COLOR;
    this.clusterCount = DEFAULT_CLUSTER_COUNT;
    this.maxClusterSize = DEFAULT_MAX_CLUSTER_SIZE;
    this.amplitude = DEFAULT_AMPLITUDE;
    this.amplitudeGamma = DEFAULT_HEIGHT_GAMMA;
    this._baseColor = BASE_COLOR.clone(); // hue/saturation/brilliance applied, see _applyColor
    // One InstancedMesh per tier rather than one mesh with a per-instance
    // texture index: three.js has no built-in way to vary which texture an
    // instance samples, short of a hand-rolled shader. Every mesh is sized
    // for the full instance count since any physical slot can be any tier
    // from one generation to the next -- see _tierFor, and _hideInstance,
    // which always clears a retiring slot on all three so a stale transform
    // never lingers on a mesh that slot has moved on from.
    this.meshPlain = new THREE.InstancedMesh(boxGeometry, this.materialPlain, this.maxInstances);
    this.meshWindows = new THREE.InstancedMesh(boxGeometry, sideMaterials(this.materialWindows), this.maxInstances);
    this.meshBricked = new THREE.InstancedMesh(boxGeometry, sideMaterials(this.materialBricked), this.maxInstances);
    this.meshes = [this.meshPlain, this.meshWindows, this.meshBricked];
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // see trees.js's own note on spread-out instances
      this.group.add(mesh);
    }
    this.chimneyMesh = new THREE.InstancedMesh(chimneyGeometry, this.chimneyMaterial, this.maxInstances * MAX_CHIMNEYS_PER_SLOT);
    this.chimneyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chimneyMesh.frustumCulled = false;
    this.group.add(this.chimneyMesh);
    scene.add(this.group);
    this.group.visible = false; // see setEnabled() -- the mode toggle owns this

    this._dummy = new THREE.Object3D();
    this.slots = Array.from({ length: this.maxInstances }, () => ({ active: false, curved: 0, spawnFrame: 0, laneStart: 0, channel: 0, widthSpan: 1, depthSpan: 1, chimneyCount: 0 }));
    // Per-lane countdown of upcoming spawn ticks to skip because a
    // depth-ilot spawned earlier in that lane is still extending forward
    // through them -- see _spawnGeneration.
    this._laneDepthRemaining = new Int32Array(this.totalLanes);
    for (let i = 0; i < this.maxInstances; i++) {
      this._hideInstance(i);
      for (const mesh of this.meshes) mesh.setColorAt(i, this._baseColor);
    }
    for (let i = 0; i < this.maxInstances * MAX_CHIMNEYS_PER_SLOT; i++) {
      this._hideChimney(i);
      this.chimneyMesh.setColorAt(i, this._baseColor);
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    this.chimneyMesh.instanceMatrix.needsUpdate = true;
    this.chimneyMesh.instanceColor.needsUpdate = true;

    let envelope = 60;
    this._envelope = envelope;
    this._profileSum = new Float64Array(terrain.bins);
    this._profileCount = 0;
  }

  setEnabled(enabled) {
    this.group.visible = enabled;
  }

  // Same three signed knobs as terrain.frag.glsl (0 = the base colour, as
  // authored), applied to any input colour rather than baked into one fixed
  // flat colour: with "couleur selon amplitude" able to reach 1 (the ember
  // ramp entirely replacing the flat colour, see _spawnGeneration's lerp),
  // applying this transform only to _baseColor left it with zero actual
  // effect at that setting -- the hue/saturation/brilliance sliders looked
  // disconnected from buildings even though they were being applied, just
  // to a colour nothing was reading anymore. Transforming the ember ramp's
  // own colour the same way keeps the link visible at every amplitude-colour
  // setting, not just when the flat colour still has some weight.
  _transformColor(input) {
    const color = input.clone();
    const luma = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
    const green = new THREE.Color(0.15, 0.85, 0.35).multiplyScalar(luma);
    const blue = new THREE.Color(0.15, 0.45, 0.95).multiplyScalar(luma);
    if (this.hue < 0) color.lerp(green, -this.hue);
    else if (this.hue > 0) color.lerp(blue, this.hue);

    const satLuma = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
    if (this.saturation < 0) {
      color.lerp(new THREE.Color(satLuma, satLuma, satLuma), -this.saturation);
    } else if (this.saturation > 0) {
      const vivid = new THREE.Color(
        satLuma + (color.r - satLuma) * 1.6,
        satLuma + (color.g - satLuma) * 1.6,
        satLuma + (color.b - satLuma) * 1.6,
      );
      color.lerp(vivid, this.saturation);
    }

    // Glow (brilliance < 0) lightens/warms the colour, echoing the shader's
    // own additive haze; chrome (brilliance > 0) has no per-pixel specular
    // to hook here, so it's approximated as a brightening toward white.
    if (this.brilliance < 0) {
      const glowed = new THREE.Color(color.r + 0.16, color.g + 0.13, color.b + 0.09).lerp(new THREE.Color(1, 1, 1), 0.12);
      color.lerp(glowed, -this.brilliance * 0.65);
    } else if (this.brilliance > 0) {
      color.lerp(new THREE.Color(1, 1, 1), this.brilliance * 0.3);
    }
    return color;
  }

  _applyColor() {
    this._baseColor.copy(this._transformColor(BASE_COLOR));
  }

  setHueShift(v) {
    this.hue = v;
    this._applyColor();
  }

  setSaturation(v) {
    this.saturation = v;
    this._applyColor();
  }

  setBrilliance(v) {
    this.brilliance = v;
    this._applyColor();
  }

  // Same signed convention as terrain.setFog: -1 (see-through) .. 0 (neutral)
  // .. 1 (dense). Buildings are fully opaque and stay that way regardless --
  // fading them toward see-through also faded their windows/brick pattern to
  // near-invisible, which read as a rendering bug rather than atmosphere.
  // Only the dense (v > 0) half actually does anything, and it does it via
  // scene-wide fog density (see main.js's applyFog, which sets
  // scene.fog.density from this same slider) rather than anything owned here.
  setFogAmount(v) {
    this.fogAmount = v;
  }

  // Mirrors terrain.setCurve exactly (see sampleHeightAtWorld's own
  // curveOffset): lifts a building's base toward the camera's eye-line near
  // both depth edges, applied on top of its own audio-driven height rather
  // than stretching it.
  setCurve(v) {
    this.curve = v;
  }

  // Same "hauteur" knob the rock terrain's own setAmplitude uses -- shared
  // so it scales both views' height at once instead of only ever moving the
  // camera's zenith lift (see main.js's zenithLiftFor, which reads this same
  // slider) while leaving the buildings' own scale untouched.
  setAmplitude(v) {
    this.amplitude = v;
  }

  // How hard the envelope-normalized amplitude gets pushed down before it
  // reaches genuine peaks (see DEFAULT_HEIGHT_GAMMA's own note): 1 = no
  // curve at all (raw amplitude maps straight to height), higher values
  // squeeze more of the skyline toward the low end so only real standout
  // moments in the music read as tall, matching how dynamic the track
  // actually sounds rather than one fixed feel for every song.
  setAmplitudeGamma(v) {
    this.amplitudeGamma = v;
  }

  setProfileThreshold(v) {
    this.profileThreshold = v;
  }

  // How many merged "ilots" (runs of neighbouring lanes fused into one wider
  // building) get placed per channel, each spawn tick.
  setClusterCount(v) {
    this.clusterCount = Math.round(v);
  }

  // Widest an ilot can be, in lanes.
  setMaxClusterSize(v) {
    this.maxClusterSize = Math.round(v);
  }

  // 0 = every building stays the material's own flat colour (hue/saturation/
  // brilliance still apply, just uniformly); 1 = each building's colour also
  // progresses along the same ember ramp terrain.frag.glsl uses, driven by
  // its own amplitude, decided once at spawn like its height and gate state.
  setAmplitudeColorAmount(v) {
    this.amplitudeColorAmount = v;
  }

  // Best-effort: not every track has a captured profile (see
  // buildings-test.js's own 'p' export). Silently falls back to no gating
  // (every qualifying bin spawns a building) when there isn't one.
  loadProfile(slug) {
    this.hasProfile = false;
    this.profileValues = null;
    fetch(`/${slug}-profile.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((profile) => {
        if (!profile || !profile.values) return;
        this.profileValues = profile.values;
        this.hasProfile = true;
      })
      .catch(() => {});
  }

  // Mirrors terrain.reset(): a deliberately restarted track shouldn't leave
  // the previous track's skyline standing.
  reset() {
    this.frame = 0;
    this._profileSum.fill(0);
    this._profileCount = 0;
    this.slots.forEach((s) => { s.active = false; });
    this._laneDepthRemaining.fill(0);
    for (let i = 0; i < this.maxInstances; i++) this._hideInstance(i);
    for (let i = 0; i < this.maxInstances * MAX_CHIMNEYS_PER_SLOT; i++) this._hideChimney(i);
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.chimneyMesh.instanceMatrix.needsUpdate = true;
  }

  // Which facade tier a building this many blocks wide/deep gets -- see the
  // constructor's own note on the three materials/meshes.
  _tierFor(widthSpan, depthSpan) {
    const size = Math.max(widthSpan, depthSpan);
    if (size >= 4) return this.meshBricked;
    if (size > 1) return this.meshWindows;
    return this.meshPlain;
  }

  // Hides index i on every tier's mesh, not just whichever one last used
  // it: a given physical slot can be a different tier from one generation
  // to the next, so the mesh that doesn't get a fresh transform this time
  // must not be left showing its previous one.
  _hideInstance(i) {
    this._dummy.position.set(0, -1000, 0);
    this._dummy.scale.set(1, 0.0001, 1);
    this._dummy.updateMatrix();
    for (const mesh of this.meshes) mesh.setMatrixAt(i, this._dummy.matrix);
  }

  _hideChimney(i) {
    this._dummy.position.set(0, -1000, 0);
    this._dummy.scale.set(1, 0.0001, 1);
    this._dummy.updateMatrix();
    this.chimneyMesh.setMatrixAt(i, this._dummy.matrix);
  }

  // Delegates to terrain.worldXForBin (see trees.js's own use of it) instead
  // of re-deriving the bin->position mapping by hand, so this automatically
  // follows the same "vallée au milieu" / "basses au milieu" mirroring the
  // rock terrain and the trees already respect, rather than always reading
  // as the un-mirrored layout.
  _laneWorldX(laneIndexInChannel, channel) {
    const bin = laneIndexInChannel * this.binStride;
    return this.terrain.worldXForBin(bin, channel);
  }

  // One entry per lane, 0..LANES_PER_CHANNEL-1: >=1 means "lead lane of an
  // ilot this many lanes wide" (1 = an ordinary standalone building), 0 means
  // "absorbed into the ilot led by an earlier lane, spawn nothing here".
  // Recomputed fresh every spawn tick -- which ilot forms where is decided
  // once per generation, exactly like each building's own height and gate
  // state, not something that reshuffles under buildings already in flight.
  // `preUsed` marks lanes that are mid-way through a depth ilot (see
  // _spawnGeneration) as already spoken for, so a width ilot never starts or
  // reaches into a lane whose box already exists from an earlier tick.
  _computeClusterSpans(preUsed) {
    const spans = new Array(LANES_PER_CHANNEL).fill(1);
    if (this.clusterCount <= 0 || this.maxClusterSize < 2) return spans;
    const used = preUsed.slice();
    let placed = 0;
    let attempts = 0;
    while (placed < this.clusterCount && attempts < LANES_PER_CHANNEL * 4) {
      attempts++;
      const start = Math.floor(Math.random() * LANES_PER_CHANNEL);
      const room = LANES_PER_CHANNEL - start;
      if (used[start] || room < 2) continue;
      const size = 2 + Math.floor(Math.random() * (Math.min(this.maxClusterSize, room) - 1));
      let overlaps = false;
      for (let i = start; i < start + size; i++) if (used[i]) { overlaps = true; break; }
      if (overlaps) continue;
      for (let i = start; i < start + size; i++) used[i] = true;
      spans[start] = size;
      for (let i = start + 1; i < start + size; i++) spans[i] = 0;
      placed++;
    }
    return spans;
  }

  _spawnGeneration(left, right, scale) {
    const spawnIndex = Math.floor(this.frame / SPAWN_INTERVAL);
    const genSlot = spawnIndex % this.generationsPerLane;
    this._profileCount++;

    for (let channel = 0; channel < 2; channel++) {
      const raw = channel === 0 ? left : right;
      const preUsed = new Array(LANES_PER_CHANNEL).fill(false);
      for (let li = 0; li < LANES_PER_CHANNEL; li++) {
        const lane = channel === 0 ? li : LANES_PER_CHANNEL + li;
        if (this._laneDepthRemaining[lane] > 0) preUsed[li] = true;
      }
      const spans = this._computeClusterSpans(preUsed);
      for (let laneIndexInChannel = 0; laneIndexInChannel < LANES_PER_CHANNEL; laneIndexInChannel++) {
        const lane = channel === 0 ? laneIndexInChannel : LANES_PER_CHANNEL + laneIndexInChannel;
        const slotIndex = lane * this.generationsPerLane + genSlot;
        const slot = this.slots[slotIndex];

        if (this._laneDepthRemaining[lane] > 0) {
          // A depth ilot spawned in an earlier tick is still extending
          // forward through this lane -- its own (already-written) slot
          // covers this generation's footprint too, so nothing new spawns.
          this._laneDepthRemaining[lane]--;
          slot.active = false;
          continue;
        }

        const span = spans[laneIndexInChannel];
        if (span === 0) {
          // Absorbed into a preceding lane's width ilot -- nothing spawns
          // here, that wider building already covers this lane's footprint.
          slot.active = false;
          continue;
        }

        // An ilot's height/colour/gate all come from its tallest member
        // bin -- the same "a city block reads by its most prominent
        // building" idea as picking one bin's value at all, just applied
        // over the merged span instead of a single lane.
        let bin = laneIndexInChannel * this.binStride;
        let scaledByte = Math.min(255, Math.round((raw[bin] || 0) * scale));
        for (let k = 1; k < span; k++) {
          const otherBin = (laneIndexInChannel + k) * this.binStride;
          const otherScaled = Math.min(255, Math.round((raw[otherBin] || 0) * scale));
          if (otherScaled > scaledByte) { scaledByte = otherScaled; bin = otherBin; }
        }
        this._profileSum[bin] += scaledByte;

        let passesGate = true;
        if (this.hasProfile) {
          const avg = Math.max(this.profileValues[bin], 2);
          passesGate = scaledByte / avg >= this.profileThreshold;
        }
        slot.active = passesGate;
        const rawNorm = scaledByte / 255;
        // Height reads the user-adjustable gamma (setAmplitudeGamma) --
        // colour deliberately does not, and always uses the fixed default
        // instead: they're two separate concerns (how tall vs. how the
        // ember ramp is distributed), and tying them together meant dialling
        // in the height dynamics also warped the colour spread as a side
        // effect. See emberColor's own call below.
        const heightCurved = Math.pow(rawNorm, this.amplitudeGamma);
        // The audio-derived shape (heightCurved, 0..1) is fixed forever at
        // spawn, same as the gate decision -- but the "hauteur" slider's own
        // scale is a live global knob, not sampled data, so it must NOT be
        // baked in here: doing that left already-flying buildings stuck at
        // whatever scale was in effect when they spawned, so a mid-track
        // slider drag only affected new buildings and read as the whole
        // skyline tilting rather than uniformly resizing. See
        // _updateInstances, which multiplies by this.amplitude every frame.
        slot.curved = heightCurved;
        slot.spawnFrame = this.frame;
        slot.widthSpan = span;
        // Lane indices, not a baked worldX: terrain.width can change while
        // this building is still in flight (the "largeur" slider), and
        // worldXForBin reads it live, so recomputing from these every frame
        // in _updateInstances keeps already-spawned buildings in step with
        // the current width instead of freezing them at spawn-time positions.
        slot.laneStart = laneIndexInChannel;
        slot.channel = channel;

        // Depth ilot: independent of the width decision above (a run can be
        // wide-and-shallow, narrow-and-deep, or anything between -- no
        // correlation between the two axes) -- extends this same box
        // forward across the next few generations instead of just this one,
        // by locking this lane out of spawning anything new until it's done.
        let depthSpan = 1;
        if (this.clusterCount > 0 && this.maxClusterSize >= 2 && Math.random() < this.clusterCount / LANES_PER_CHANNEL) {
          depthSpan = 2 + Math.floor(Math.random() * (this.maxClusterSize - 1));
          this._laneDepthRemaining[lane] = depthSpan - 1;
        }
        slot.depthSpan = depthSpan;
        // Chimneys: none on a lone 1x1 block, one once an ilot spans more
        // than a single block on either axis, the full set from 4 blocks --
        // see chimneyCountFor/CHIMNEY_LAYOUTS. Decided once here, like
        // everything else about this generation.
        slot.chimneyCount = chimneyCountFor(span, depthSpan);

        // Decided once at spawn, like height and gate state: blends from the
        // flat base colour toward the ember ramp by this building's own
        // amplitude, by however much setAmplitudeColorAmount currently
        // allows. Uses its own fixed curve (COLOR_GAMMA), not the height
        // slider's -- see the note above heightCurved. The ramp goes through
        // the same hue/saturation/brilliance transform as the flat colour
        // (see _transformColor) so the terrain's colour sliders stay linked
        // even at amplitude-colour = 1, where the ramp is the only thing
        // actually shown.
        const colorCurved = Math.pow(rawNorm, COLOR_GAMMA);
        const ember = this._transformColor(emberColor(colorCurved));
        const color = this._baseColor.clone().lerp(ember, this.amplitudeColorAmount);
        this._tierFor(span, depthSpan).setColorAt(slotIndex, color);
        for (let k = 0; k < slot.chimneyCount; k++) {
          this.chimneyMesh.setColorAt(slotIndex * MAX_CHIMNEYS_PER_SLOT + k, color);
        }
      }
    }
    for (const mesh of this.meshes) mesh.instanceColor.needsUpdate = true;
    this.chimneyMesh.instanceColor.needsUpdate = true;
  }

  // Repositions every live building along its own straight path from the far
  // edge to the camera -- exactly trees.js's own update().
  _updateInstances() {
    for (let i = 0; i < this.maxInstances; i++) {
      const slot = this.slots[i];
      const age = this.frame - slot.spawnFrame;
      if (!slot.active || age < 0 || age >= this.crossingFrames) {
        this._hideInstance(i);
        for (let k = 0; k < MAX_CHIMNEYS_PER_SLOT; k++) this._hideChimney(i * MAX_CHIMNEYS_PER_SLOT + k);
        continue;
      }
      // A depth ilot's lead generation marks its far (oldest) edge, not its
      // centre -- the merged block extends forward (toward the camera) to
      // also cover the generations that were skipped for it, so its visual
      // centre sits ahead of a plain single-generation box's by half the
      // extra length.
      const worldZ = this.depth * (age / this.crossingFrames - 0.5) + ((slot.depthSpan - 1) / 2) * this.cellDepth;
      // Literally terrain.sampleHeightAtWorld's own curveOffset formula,
      // normalized against terrain.depth (not this class's own longer
      // depth) so it's identical to the rock terrain's curve in the region
      // that matters, out to +-terrain.depth/2. Clamped there rather than
      // left to keep growing: unclamped, depthNorm^2 grows quadratically
      // for the whole extra stretch beyond terrain.depth/2 (see
      // DEPTH_MULTIPLIER), so within a few frames of crossing that
      // boundary the offset exploded to a huge, effectively-constant value
      // -- every building past that point converged on nearly the same
      // extreme Y regardless of its own age, reading as a pile of frozen
      // buildings rather than each one fading off on its own schedule.
      const depthNorm = Math.max(-1, Math.min(1, -worldZ / (this.terrain.depth / 2)));
      const curveOffset = this.curve * depthNorm * depthNorm;
      // Recomputed from lane indices every frame (not a worldX baked in at
      // spawn) so a live terrain.setWidth() reflows already-flying buildings
      // too -- see the note in _spawnGeneration.
      const firstX = this._laneWorldX(slot.laneStart, slot.channel);
      const lastX = this._laneWorldX(slot.laneStart + slot.widthSpan - 1, slot.channel);
      const worldX = (firstX + lastX) / 2;
      this._dummy.position.set(worldX, curveOffset, worldZ);
      this._dummy.rotation.set(0, 0, 0);
      // this.amplitude read live, every frame -- see the note in
      // _spawnGeneration on why it can't be baked into a fixed height at
      // spawn time. Box width scales the same way -- the shared geometry's
      // own cellWidth is fixed at construction (this._baseWidth), so
      // terrain.width drifting away from that is applied here as a live
      // multiplier, exactly like Terrain's own mesh.scale.x = width/baseWidth.
      const height = Math.max(slot.curved * this.amplitude, 0.15);
      const widthScale = this.terrain.width / this._baseWidth;
      // Shrinks to nothing over the last 15% of the crossing instead of
      // just being hidden the instant age hits crossingFrames: up close to
      // the camera, a building's own forward motion becomes imperceptible
      // (it's already filling most of the view, so getting a bit closer
      // barely changes anything on screen) long before it actually retires,
      // which read as "stops and sits there" for a long stretch before
      // abruptly popping out of existence. Shrinking it away explicitly
      // guarantees a bounded, visible exit no matter how that final stretch
      // looks otherwise.
      const lifeFrac = age / this.crossingFrames;
      const endShrink = lifeFrac > 0.85 ? 1 - smoothstep(0.85, 1, lifeFrac) : 1;
      this._dummy.scale.set(slot.widthSpan * widthScale * endShrink, height * endShrink, slot.depthSpan * endShrink);
      this._dummy.updateMatrix();
      this._tierFor(slot.widthSpan, slot.depthSpan).setMatrixAt(i, this._dummy.matrix);

      // Chimneys ride the roof: same worldX/worldZ as the building itself,
      // spread out over its actual (live-scaled) footprint by each layout
      // offset, sitting right at the current roof height -- so they track
      // amplitude/width/curve changes exactly like the building they're on.
      const footprintW = slot.widthSpan * widthScale * this.cellWidth;
      const footprintD = slot.depthSpan * this.cellDepth;
      const layout = CHIMNEY_LAYOUTS[slot.chimneyCount];
      for (let k = 0; k < MAX_CHIMNEYS_PER_SLOT; k++) {
        const chimneyIndex = i * MAX_CHIMNEYS_PER_SLOT + k;
        if (k >= slot.chimneyCount) { this._hideChimney(chimneyIndex); continue; }
        const [ox, oz] = layout[k];
        // Roof height and scale both follow the same endShrink as the
        // building itself, so a chimney doesn't end up floating above (or
        // towering over) a building that's shrinking away beneath it.
        this._dummy.position.set(worldX + ox * footprintW, curveOffset + height * endShrink, worldZ + oz * footprintD);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.set(endShrink, endShrink, endShrink);
        this._dummy.updateMatrix();
        this.chimneyMesh.setMatrixAt(chimneyIndex, this._dummy.matrix);
      }
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.chimneyMesh.instanceMatrix.needsUpdate = true;
  }

  // Called once per audio frame, exactly like terrain.update(freq).
  // `freq` is only passed while audio is actually playing (see main.js) --
  // called unconditionally either way, because retiring/repositioning
  // already-spawned buildings must keep going through any playback gap
  // (a track ending before the next one starts, autochain's non-gapless
  // fallback, a deliberate stop-then-restart). Terrain gets away with only
  // updating while playing because a paused terrain just looks like a still
  // image; buildings are discrete objects clearly mid-flight, so freezing
  // them mid-crossing whenever audio isn't flowing read as a bug (reported
  // as "buildings stuck at the end of the crossing") rather than a pause.
  // Spawning new generations is the only part that genuinely needs live
  // audio, so that alone stays conditional.
  update(freq) {
    if (freq) {
      const { left, right } = freq;
      let frameMax = 0;
      for (let i = 0; i < left.length; i++) {
        if (left[i] > frameMax) frameMax = left[i];
        if (right[i] > frameMax) frameMax = right[i];
      }
      this._envelope = Math.max(frameMax, this._envelope * 0.995, 30);
      const scale = 255 / this._envelope;

      if (this.frame % SPAWN_INTERVAL === 0) {
        this._spawnGeneration(left, right, scale);
      }
    }
    this._updateInstances();
    this.frame++;
  }
}
