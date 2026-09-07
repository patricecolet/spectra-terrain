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

const AMPLITUDE = 6;
const BASE_COLOR = new THREE.Color(0x8fa8c9);
const BASE_OPACITY = 0.85;
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
// Envelope-normalized amplitude clusters near the top of its own range far
// more often than it sits low (a mastered track's bins are frequently close
// to the current peak, not just spiking rarely) -- read straight through,
// that means most buildings sit near max height and land on the ramp's
// brightest/yellow stop, with barely any visual spread. Raising the
// normalized value to a power > 1 pushes everything but genuine peaks back
// down (0.5 -> ~0.18 at gamma 2.5), so only real standout moments reach the
// top and typical ones spread across the lower-to-mid range instead of
// bunching at it. Height and colour both read this curved value; the
// profile-gate comparison deliberately does not (see _spawnGeneration) --
// the captured profile JSON was measured on the linear scale.
const AMPLITUDE_GAMMA = 2.5;

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

export class Buildings {
  constructor({ scene, terrain }) {
    this.terrain = terrain;
    this.binStride = Math.max(1, Math.floor(terrain.bins / LANES_PER_CHANNEL));
    this.crossingFrames = terrain.historyLength; // same crossing time as the rock terrain
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

    const cellWidth = (terrain.width / 2 / LANES_PER_CHANNEL) * 0.85;
    const cellDepth = (terrain.depth / this.generationsPerLane) * 0.85;
    const boxGeometry = new THREE.BoxGeometry(cellWidth, 1, cellDepth);
    boxGeometry.translate(0, 0.5, 0); // pivot at the base, like trees' trunk geometry
    // Transparent + partial opacity, so this integrates with the backdrop
    // the same way the terrain's own shader fades into it, instead of solid
    // opaque boxes sitting flatly on top of the artwork. Scene-wide fog (see
    // main.js, where scene.fog is set) does the same "fade into the distance"
    // job the terrain's own shader-side fog does -- kept out of this class
    // since fog is a scene-level property, not something a mesh owns.
    // Kept white: per-instance colour (see setColorAt in _spawnGeneration)
    // multiplies this material colour, and every building always writes its
    // own final colour there -- keeping the material itself neutral avoids
    // that multiplication double-applying the hue/saturation/brilliance
    // adjustments already baked into each instance's own colour.
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      flatShading: true,
      transparent: true,
      opacity: BASE_OPACITY,
    });
    this.hue = 0;
    this.saturation = 0;
    this.brilliance = 0;
    this.fogAmount = 0;
    this.curve = 0;
    this.amplitudeColorAmount = DEFAULT_AMPLITUDE_COLOR;
    this._baseColor = BASE_COLOR.clone(); // hue/saturation/brilliance applied, see _applyColor
    this.mesh = new THREE.InstancedMesh(boxGeometry, this.material, this.maxInstances);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // see trees.js's own note on spread-out instances
    this.group.add(this.mesh);
    scene.add(this.group);
    this.group.visible = false; // see setEnabled() -- the mode toggle owns this

    this._dummy = new THREE.Object3D();
    this.slots = Array.from({ length: this.maxInstances }, () => ({ active: false, height: 0, spawnFrame: 0, worldX: 0 }));
    for (let i = 0; i < this.maxInstances; i++) {
      this._hideInstance(i);
      this.mesh.setColorAt(i, this._baseColor);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;

    let envelope = 60;
    this._envelope = envelope;
    this._profileSum = new Float64Array(terrain.bins);
    this._profileCount = 0;
  }

  setEnabled(enabled) {
    this.group.visible = enabled;
  }

  // Same three signed knobs as terrain.frag.glsl (0 = the base colour, as
  // authored), reapplied to this one flat material colour instead of a
  // per-pixel palette -- there's only one colour here, not a height ramp, so
  // this recomputes it from scratch from BASE_COLOR every call rather than
  // nudging the current value, to avoid drifting under repeated calls.
  _applyColor() {
    const color = BASE_COLOR.clone();
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

    this._baseColor.copy(color);
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
  // .. 1 (dense). The positive half is scene-wide fog (see main.js, which
  // owns scene.fog -- a single shared property, not something this class
  // can own by itself); the negative half fades this material toward
  // see-through, mirroring terrain.frag.glsl's own ghost effect.
  setFogAmount(v) {
    this.fogAmount = v;
    const transparency = Math.max(-v, 0);
    this.material.opacity = THREE.MathUtils.lerp(BASE_OPACITY, BASE_OPACITY * 0.15, transparency);
  }

  // Mirrors terrain.setCurve exactly (see sampleHeightAtWorld's own
  // curveOffset): lifts a building's base toward the camera's eye-line near
  // both depth edges, applied on top of its own audio-driven height rather
  // than stretching it.
  setCurve(v) {
    this.curve = v;
  }

  setProfileThreshold(v) {
    this.profileThreshold = v;
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
    for (let i = 0; i < this.maxInstances; i++) this._hideInstance(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _hideInstance(i) {
    this._dummy.position.set(0, -1000, 0);
    this._dummy.scale.set(1, 0.0001, 1);
    this._dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this._dummy.matrix);
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

  _spawnGeneration(left, right, scale) {
    const spawnIndex = Math.floor(this.frame / SPAWN_INTERVAL);
    const genSlot = spawnIndex % this.generationsPerLane;
    this._profileCount++;
    for (let lane = 0; lane < this.totalLanes; lane++) {
      const channel = lane < LANES_PER_CHANNEL ? 0 : 1;
      const laneIndexInChannel = channel === 0 ? lane : lane - LANES_PER_CHANNEL;
      const bin = laneIndexInChannel * this.binStride;
      const rawByte = (channel === 0 ? left[bin] : right[bin]) || 0;
      const scaledByte = Math.min(255, Math.round(rawByte * scale));
      this._profileSum[bin] += scaledByte;

      const slotIndex = lane * this.generationsPerLane + genSlot;
      const slot = this.slots[slotIndex];
      let passesGate = true;
      if (this.hasProfile) {
        const avg = Math.max(this.profileValues[bin], 2);
        passesGate = scaledByte / avg >= this.profileThreshold;
      }
      slot.active = passesGate;
      const curved = Math.pow(scaledByte / 255, AMPLITUDE_GAMMA);
      slot.height = Math.max(curved * AMPLITUDE, 0.15);
      slot.spawnFrame = this.frame;
      slot.worldX = this._laneWorldX(laneIndexInChannel, channel);

      // Decided once at spawn, like height and gate state: blends from the
      // flat base colour toward the ember ramp by this building's own
      // amplitude, by however much setAmplitudeColorAmount currently allows.
      const color = this._baseColor.clone().lerp(emberColor(curved), this.amplitudeColorAmount);
      this.mesh.setColorAt(slotIndex, color);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  // Repositions every live building along its own straight path from the far
  // edge to the camera -- exactly trees.js's own update().
  _updateInstances() {
    for (let i = 0; i < this.maxInstances; i++) {
      const slot = this.slots[i];
      const age = this.frame - slot.spawnFrame;
      if (!slot.active || age < 0 || age >= this.crossingFrames) {
        this._hideInstance(i);
        continue;
      }
      const worldZ = this.terrain.depth * (age / this.crossingFrames - 0.5);
      // Same curveOffset math as terrain.sampleHeightAtWorld: lifts the base
      // toward the camera's eye-line near both depth edges, independent of
      // this building's own audio-driven height.
      const depthNorm = -worldZ / (this.terrain.depth / 2);
      const curveOffset = this.curve * depthNorm * depthNorm;
      this._dummy.position.set(slot.worldX, curveOffset, worldZ);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.set(1, slot.height, 1);
      this._dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this._dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Called once per audio frame, exactly like terrain.update(freq).
  update({ left, right }) {
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
    this._updateInstances();
    this.frame++;
  }
}
