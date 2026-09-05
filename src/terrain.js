import * as THREE from 'three';
import vertexShader from './shaders/terrain.vert.glsl?raw';
import fragmentShader from './shaders/terrain.frag.glsl?raw';

// A ground plane whose height comes from a scrolling texture: each frame
// writes the current left/right FFT spectra into one row of a fixed-size
// texture (a circular buffer, R = left channel, G = right channel) and
// advances a scroll offset uniform, instead of re-uploading or reshuffling
// the whole texture every frame. The vertex shader mirrors the frequency
// axis left/right around the centre seam (see uBassCenter).
export class Terrain {
  constructor({
    width = 24,
    depth = 48,
    segmentsX = 128,
    segmentsY = 256,
    bins = 128,
    historyLength = 256,
    amplitude = 5,
    bassCenter = false,
    fogColor = 0x05070d,
    fog = 0,
  } = {}) {
    this.bins = bins;
    this.historyLength = historyLength;
    this.frame = 0;

    this.dataArray = new Uint8Array(bins * historyLength * 4);
    this.texture = new THREE.DataTexture(this.dataArray, bins, historyLength, THREE.RGBAFormat);
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;

    this.segmentsX = segmentsX;
    this.segmentsY = segmentsY;
    this.width = width;
    this.depth = depth;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHeightMap: { value: this.texture },
        uOffset: { value: 0 },
        uAmplitude: { value: amplitude },
        uBassCenter: { value: bassCenter ? 1 : 0 },
        uCurve: { value: 0 },
        uHalfDepth: { value: this.depth / 2 },
        uStyle: { value: 0 }, // 0 = smooth shading, 1 = drawn/toon banding
        uHueShift: { value: 0 }, // -1 green .. 0 neutral .. 1 blue
        uSaturation: { value: 0 }, // -1 black & white .. 0 neutral (measured palette) .. 1 hyper-saturated
        uBrilliance: { value: 0 }, // -1 glow .. 0 neutral .. 1 chrome
        uFogColor: { value: new THREE.Color(fogColor) },
        uFogAmount: { value: fog }, // -1 see-through .. 0 neutral .. 1 dense fog
        uVibration: { value: 0 }, // -1 soft/slow ripple .. 0 neutral (still) .. 1 hard/fast jitter
        uVibrationLevel: { value: 0 }, // 0..1 broadband loudness -- drives the "mou" wave
        uVibrationBass: { value: 0 }, // 0..1 bass-only envelope -- drives the "dur" jitter
        uVibrationSpatial: { value: 1 }, // <1 widens the ripple (bass-heavy), >1 tightens it (treble-heavy)
        uVibrationTime: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true, // lets the edge fade (see fragment shader) blend into the page background
    });

    this.baseWidth = width; // the width the geometry was actually built at
    this.mesh = new THREE.Mesh(this._buildGeometry(), this.material);
    this.mesh.rotation.x = -Math.PI / 2; // local Z displacement becomes world "up"
  }

  _buildGeometry() {
    return new THREE.PlaneGeometry(this.width, this.depth, this.segmentsX - 1, this.segmentsY - 1);
  }

  // Widens/narrows the ground plane (e.g. on window resize, so the spectrum
  // spreads to fill wide viewports and narrows on tall/mobile ones) by
  // scaling the mesh on its width axis. Rebuilding the geometry instead would
  // mean 32k fresh vertices per change — fine once on resize, impossible for
  // a continuous drift, which is why the automatic tuning used to move the
  // width in visible whole-unit steps. Everything the shaders work with (uv,
  // position.y/uHalfDepth) is local, so scaling touches nothing else, and
  // three.js keeps normalMatrix in step so the lighting stays correct.
  setWidth(width) {
    this.width = width;
    this.mesh.scale.x = width / this.baseWidth;
  }

  setAmplitude(amplitude) {
    this.material.uniforms.uAmplitude.value = amplitude;
  }

  setCurve(curve) {
    this.material.uniforms.uCurve.value = curve;
  }

  setStyle(style) {
    this.material.uniforms.uStyle.value = style;
  }

  setHueShift(hueShift) {
    this.material.uniforms.uHueShift.value = hueShift;
  }

  setSaturation(saturation) {
    this.material.uniforms.uSaturation.value = saturation;
  }

  setBrilliance(brilliance) {
    this.material.uniforms.uBrilliance.value = brilliance;
  }

  setFog(amount) {
    this.material.uniforms.uFogAmount.value = amount;
  }

  setVibration(amount) {
    this.material.uniforms.uVibration.value = amount;
  }

  // Called every frame regardless of playback state, so the ripple settles
  // back to still (levels -> 0) on their own in silence even with the slider
  // left dialled in, instead of needing to be switched off by hand.
  updateVibration(dt, level, bass, spatial) {
    this.material.uniforms.uVibrationTime.value += dt;
    this.material.uniforms.uVibrationLevel.value = level;
    this.material.uniforms.uVibrationBass.value = bass;
    this.material.uniforms.uVibrationSpatial.value = spatial;
  }

  setBassCenter(enabled) {
    this.material.uniforms.uBassCenter.value = enabled ? 1 : 0;
  }

  toggleBassCenter() {
    const next = this.material.uniforms.uBassCenter.value === 0 ? 1 : 0;
    this.material.uniforms.uBassCenter.value = next;
    return next === 1;
  }

  // Clears the scrolling height buffer and restarts the scroll from its own
  // beginning. Without this, a deliberately restarted track still shows the
  // previous track's bumps sitting at the near edge (they take up to
  // historyLength frames -- a few seconds -- to scroll out on their own),
  // reading as if the new track were already midway through instead of
  // starting fresh and filling in from the far edge like it should.
  reset() {
    this.dataArray.fill(0);
    this.texture.needsUpdate = true;
    this.frame = 0;
    this.material.uniforms.uOffset.value = 0;
  }

  // Bilinear sample of one channel (0 = R/left, 1 = G/right) of dataArray,
  // mirroring the texture's own filtering/wrapping (LinearFilter, U clamped,
  // V repeated) instead of doing this on the GPU: the game needs to query
  // "how tall is the terrain here" from plain JS, and the vertex shader's
  // displacement never touches the CPU-side geometry buffers, so there is
  // nothing to raycast against otherwise.
  _sampleTexel(u, v, channel) {
    const bins = this.bins;
    const rows = this.historyLength;

    const uc = Math.min(Math.max(u, 0), 1);
    const fx = uc * bins - 0.5;
    let x0 = Math.floor(fx);
    let x1 = x0 + 1;
    const tx = fx - x0;
    x0 = Math.min(Math.max(x0, 0), bins - 1);
    x1 = Math.min(Math.max(x1, 0), bins - 1);

    const vw = v - Math.floor(v); // RepeatWrapping
    const fy = vw * rows - 0.5;
    let y0 = Math.floor(fy);
    let y1 = y0 + 1;
    const ty = fy - y0;
    y0 = ((y0 % rows) + rows) % rows;
    y1 = ((y1 % rows) + rows) % rows;

    const get = (xi, yi) => this.dataArray[(yi * bins + xi) * 4 + channel];
    const top = get(x0, y0) + (get(x1, y0) - get(x0, y0)) * tx;
    const bot = get(x0, y1) + (get(x1, y1) - get(x0, y1)) * tx;
    return (top + (bot - top) * ty) / 255;
  }

  // World-space height (audio-driven bump + the static courbe bend, not the
  // cosmetic vibration ripple -- collision needs a height that doesn't jitter
  // frame to frame) at (worldX, worldZ), for the game's ball to walk on.
  // Mirrors sampleHeightValue() and the courbe term in terrain.vert.glsl.
  sampleHeightAtWorld(worldX, worldZ) {
    const u = 0.5 + worldX / this.width;
    const v = 0.5 - worldZ / this.depth;

    const bassCenter = this.material.uniforms.uBassCenter.value;
    const isLeft = u < 0.5;
    const localU = isLeft ? u / 0.5 : (u - 0.5) / 0.5;
    const mix = (a, b, t) => a + (b - a) * t;
    const sampleU = isLeft ? mix(localU, 1 - localU, bassCenter) : mix(1 - localU, localU, bassCenter);
    const channel = isLeft ? 0 : 1;

    const value = this._sampleTexel(sampleU, v + this.material.uniforms.uOffset.value, channel);
    const height = value * this.material.uniforms.uAmplitude.value;

    const depthNorm = -worldZ / (this.depth / 2); // local Y (pre-rotation) = -worldZ, see Game
    const curveOffset = this.material.uniforms.uCurve.value * depthNorm * depthNorm;

    return height + curveOffset;
  }

  update({ left, right }) {
    const row = this.frame % this.historyLength;
    const rowOffset = row * this.bins * 4;
    for (let i = 0; i < this.bins; i++) {
      const idx = rowOffset + i * 4;
      this.dataArray[idx] = left[i] || 0;      // R = left channel
      this.dataArray[idx + 1] = right[i] || 0; // G = right channel
      this.dataArray[idx + 2] = 0;
      this.dataArray[idx + 3] = 255;
    }
    this.texture.needsUpdate = true;

    this.frame++;
    // Positive-growing offset: freshly written rows enter at one edge and
    // scroll across toward the camera, so the newest sound is always the
    // one just "arriving" rather than the one about to disappear.
    this.material.uniforms.uOffset.value = this.frame / this.historyLength;
  }
}
