import * as THREE from 'three';

const TRUNK_HEIGHT = 0.55;
const TRUNK_RADIUS = 0.055;
const FOLIAGE_HEIGHT = 1.1;
const FOLIAGE_RADIUS = 0.45;
const MAX_TREES = 48;

const MIN_PEAK = 60; // out of 255 -- floor against pure noise; how "grand" a candidate must be is now the random weighting's job, not a hard cutoff
const NEIGHBOR_SPAN = 3; // how many bins out to measure a peak's isolation from the wider terrain around it
const MIN_SPACING = 2.5; // world units -- no two live trees closer than this, or a sustained note fences a whole ridge
const JITTER_X = 0.3; // world units of random lateral scatter added at spawn
const DENSITY = 1; // >1 = denser forest (spawns more often), <1 = sparser -- see _minSpawnGap
const TREE_BASE_HEIGHT = TRUNK_HEIGHT + FOLIAGE_HEIGHT; // nominal tree height at scale 1

// Trees mark spectral peaks, picked at random (weighted toward isolated
// spikes over broad ridges -- see _findPeaks/onSpectrum) rather than always
// the single loudest bin, at a rate DENSITY controls. Instanced (trunk +
// foliage, two draw calls covering every tree) since this is one of the few
// places in the app cheap enough to just instance.
//
// A tree rides the same scroll the terrain's own waterfall does: it's spawned
// at the far edge the moment its peak is seen and reaches the near edge
// historyLength frames later, exactly like the height data itself scrolling
// past (see update() below and terrain.js's uOffset). It never needs its own
// clock for this -- terrain.frame already ticks at the right rate.
export class Trees {
  constructor({ scene, terrain, maxTrees = MAX_TREES }) {
    this.terrain = terrain;
    this.maxTrees = maxTrees;

    const trunkGeometry = new THREE.CylinderGeometry(TRUNK_RADIUS * 0.7, TRUNK_RADIUS, TRUNK_HEIGHT, 5);
    trunkGeometry.translate(0, TRUNK_HEIGHT / 2, 0); // pivot at the base, not the centre
    const foliageGeometry = new THREE.ConeGeometry(FOLIAGE_RADIUS, FOLIAGE_HEIGHT, 6);
    foliageGeometry.translate(0, TRUNK_HEIGHT + FOLIAGE_HEIGHT / 2, 0); // sits on top of the trunk

    const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0x6b4531, flatShading: true });
    // Brighter/more saturated than a "realistic" pine so it still pops
    // against the terrain's warm ember palette regardless of which peak it
    // lands on.
    const foliageMaterial = new THREE.MeshLambertMaterial({ color: 0x3fae4a, flatShading: true });

    this.trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, maxTrees);
    this.foliageMesh = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, maxTrees);
    this.trunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.foliageMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // InstancedMesh's default frustum test uses its geometry's own (tiny,
    // near-origin) bounding sphere, not one covering where the instances
    // actually are -- with a per-instance boundingSphere never computed,
    // three.js culls the whole draw call, every instance, every frame. Only
    // 48 trees scattered across one terrain plane, so skipping the culling
    // test entirely costs nothing.
    this.trunkMesh.frustumCulled = false;
    this.foliageMesh.frustumCulled = false;
    scene.add(this.trunkMesh);
    scene.add(this.foliageMesh);

    // The terrain shades itself entirely in-shader, and Game's own light only
    // turns on with the ball game, so trees need a light of their own that's
    // always on -- same fixed direction as Game's so the two match if both
    // happen to be visible together.
    this.light = new THREE.DirectionalLight(0xffffff, 1.2);
    this.light.position.set(3, 6, 7);
    scene.add(this.light);

    this.slots = Array.from({ length: maxTrees }, () => ({
      active: false, x: 0, spawnFrame: 0, scale: 1, rotationY: 0,
    }));
    this._density = DENSITY;
    this._minSpawnGap = this._computeMinSpawnGap();
    this._framesSinceSpawn = this._minSpawnGap;

    this._dummy = new THREE.Object3D();
    this._hideAll();
  }

  // A tree takes historyLength frames to cross the whole terrain, so
  // historyLength/maxTrees frames between spawns is what makes a full pool
  // last exactly one full crossing -- density scales that baseline rate
  // (>1 shortens the gap for a denser forest, at the cost of recycling trees
  // before they finish crossing once the pool can't keep up).
  _computeMinSpawnGap() {
    return Math.max(1, Math.round(this.terrain.historyLength / this.maxTrees / this._density));
  }

  setDensity(density) {
    this._density = density;
    this._minSpawnGap = this._computeMinSpawnGap();
  }

  // Trees are planted on the rock terrain's own surface (see onSpectrum's
  // height-gate against terrain.sampleHeightAtWorld) -- with no terrain shown
  // (e.g. the buildings alternative view), they'd float with nothing under
  // them, so the host app hides them together with the terrain.
  setVisible(visible) {
    this.trunkMesh.visible = visible;
    this.foliageMesh.visible = visible;
  }

  _hideAll() {
    this._dummy.position.set(0, -1000, 0);
    this._dummy.rotation.set(0, 0, 0);
    this._dummy.scale.setScalar(0.0001);
    this._dummy.updateMatrix();
    for (let i = 0; i < this.maxTrees; i++) {
      this.trunkMesh.setMatrixAt(i, this._dummy.matrix);
      this.foliageMesh.setMatrixAt(i, this._dummy.matrix);
    }
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.foliageMesh.instanceMatrix.needsUpdate = true;
  }

  // Mirrors terrain.reset(): a deliberately restarted track shouldn't leave
  // the previous track's forest standing.
  reset() {
    this.slots.forEach((s) => { s.active = false; });
    this._framesSinceSpawn = this._minSpawnGap;
    this._hideAll();
  }

  _spawn(x, spawnFrame, scale) {
    // Prefer a free slot; once the pool is full, recycle whichever tree is
    // closest to its own natural retirement (smallest spawnFrame => largest
    // age) rather than an arbitrary one -- see _minSpawnGap above for why
    // this should rarely even trigger mid-crossing.
    let target = this.slots.find((s) => !s.active);
    if (!target) {
      target = this.slots.reduce((oldest, s) => (s.spawnFrame < oldest.spawnFrame ? s : oldest));
    }
    target.active = true;
    target.x = x;
    target.spawnFrame = spawnFrame;
    target.scale = scale;
    target.rotationY = Math.random() * Math.PI * 2;
  }

  // Every local max at or above the noise floor, each tagged with how much
  // it stands out from the *wider* terrain around it (not just its immediate
  // neighbours): a spike sitting on an otherwise quiet stretch scores high,
  // one sitting on a broad loud ridge scores low even if it's a local max
  // there too. That score is a weight, not a hard filter -- see onSpectrum.
  _findPeaks(bins) {
    const n = bins.length;
    const peaks = [];
    for (let i = NEIGHBOR_SPAN; i < n - NEIGHBOR_SPAN; i++) {
      const v = bins[i];
      if (v < MIN_PEAK) continue;
      if (v <= bins[i - 1] || v <= bins[i + 1]) continue;
      const isolation = v - Math.max(bins[i - NEIGHBOR_SPAN], bins[i + NEIGHBOR_SPAN]);
      peaks.push({ index: i, value: v, isolation });
    }
    return peaks;
  }

  // Called once per fresh spectrum row, right after terrain.update() -- see
  // main.js's animate loop. At most one spawn per call, and never sooner
  // than _minSpawnGap frames after the last one (see its own comment).
  onSpectrum(freq, terrain) {
    this._framesSinceSpawn++;
    if (this._framesSinceSpawn < this._minSpawnGap) return;

    const candidates = [
      ...this._findPeaks(freq.left).map((p) => ({ ...p, channel: 0 })),
      ...this._findPeaks(freq.right).map((p) => ({ ...p, channel: 1 })),
    ]
      .map((p) => ({ ...p, worldX: terrain.worldXForBin(p.index, p.channel) }))
      // A sustained note keeps the same lane qualifying for many consecutive
      // frames -- without this, it would just get replanted over and over,
      // marching a solid fence of trees straight up whatever ridge it sits on.
      .filter((c) => !this.slots.some((s) => s.active && Math.abs(s.x - c.worldX) < MIN_SPACING))
      .map((c) => ({ ...c, scale: 0.7 + ((c.value - MIN_PEAK) / (255 - MIN_PEAK)) * 0.6 }))
      // A tree only reads as "planted on this bump" when it's at least as
      // tall as the bump itself -- on anything taller, its base sits well
      // below the actual peak (which the mesh, not the tree, forms), so it
      // looks like it's hovering next to the terrain rather than growing out
      // of it. Comparing against the tree's own (already scaled) height, not
      // a fixed one, so a bigger tree still earns a taller bump.
      .filter((c) => terrain.sampleHeightAtWorld(c.worldX, -terrain.depth / 2) <= TREE_BASE_HEIGHT * c.scale);
    if (candidates.length === 0) return;

    // Weighted-random pick, not "take the loudest": a forest that always
    // lands on the single biggest peak reads as generated, and it never
    // touches anything but the tallest ridge. Weighting by isolation instead
    // of raw value favours a peak standing alone over one that's merely part
    // of a broad, already-tall ridge, while still leaving room for chance to
    // land almost anywhere that clears the noise floor at all.
    const weight = (c) => Math.max(c.isolation, 1);
    const totalWeight = candidates.reduce((sum, c) => sum + weight(c), 0);
    let r = Math.random() * totalWeight;
    let best = candidates[candidates.length - 1];
    for (const c of candidates) {
      r -= weight(c);
      if (r <= 0) { best = c; break; }
    }

    // Small lateral jitter so a tree doesn't sit exactly on the peak's own
    // column every time -- a forest that traces the spectrum's grid lines
    // precisely reads as generated, not grown.
    const worldX = best.worldX + (Math.random() * 2 - 1) * JITTER_X;
    const scale = best.scale;
    // terrain.frame has already advanced past the row this peak came from
    // (see terrain.js's update()); subtracting 1 lines the tree's spawn
    // frame back up with that row, so update()'s age math places it at the
    // far edge on this very tick instead of one tick "late".
    this._spawn(worldX, terrain.frame - 1, scale);
    this._framesSinceSpawn = 0;
  }

  // Repositions every live tree along the terrain's own scroll. A tree
  // spawned at frame F sits at world Z = -depth/2 (the far edge, where fresh
  // rows enter) right away and reaches +depth/2 (the near edge, by the
  // camera) exactly historyLength frames later -- the same linear scroll
  // uOffset drives the height texture with. Past that window its row has
  // been overwritten with newer data, so the tree is retired rather than
  // left standing on stale data.
  update(terrain) {
    const { depth, historyLength, frame } = terrain;
    for (let i = 0; i < this.maxTrees; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      const age = frame - slot.spawnFrame;
      if (age <= 0 || age >= historyLength) {
        slot.active = false;
        this._dummy.position.set(0, -1000, 0);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.setScalar(0.0001);
        this._dummy.updateMatrix();
        this.trunkMesh.setMatrixAt(i, this._dummy.matrix);
        this.foliageMesh.setMatrixAt(i, this._dummy.matrix);
        continue;
      }
      const worldZ = depth * (age / historyLength - 0.5);
      const worldY = terrain.sampleHeightAtWorld(slot.x, worldZ);
      this._dummy.position.set(slot.x, worldY, worldZ);
      this._dummy.rotation.set(0, slot.rotationY, 0);
      this._dummy.scale.setScalar(slot.scale);
      this._dummy.updateMatrix();
      this.trunkMesh.setMatrixAt(i, this._dummy.matrix);
      this.foliageMesh.setMatrixAt(i, this._dummy.matrix);
    }
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.foliageMesh.instanceMatrix.needsUpdate = true;
  }
}
