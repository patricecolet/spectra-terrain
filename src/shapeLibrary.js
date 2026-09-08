import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared between buildings.js (the live, music-reactive scene) and
// shape-bench.js (a standalone viewer for building-shapes.json, with no
// audio and no lane grid) -- kept in one place so a fix or a new shape type
// only has to happen once, and the bench always shows exactly what would
// actually spawn live.

export const SHAPE_LIBRARY_URL = '/building-shapes.json';

// Best-effort like buildings.js's own loadProfile: a missing or malformed
// file just resolves to an empty list rather than rejecting.
export function fetchShapeLibrary(url = SHAPE_LIBRARY_URL) {
  return fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (data && Array.isArray(data.shapes) ? data.shapes : []))
    .catch(() => []);
}

// A procedural (cone/cylinder) shape, "one unit tall, pivoted at the base"
// like every other shape in this system (see loadObjShape's own note).
// `cellUnit` converts the JSON's radius fraction into world units; pass 1
// to get it in raw "fraction of a cell" units instead, for a standalone
// preview with no lane grid of its own (see shape-bench.js).
// buildings.js's own per-lane/per-generation cell size (world units for one
// unmerged 1x1 building slot) -- factored out here, single source of truth,
// so shape-bench.js can show "how big would this shape's ilot actually be"
// without a second copy of the formula silently drifting out of sync from
// buildings.js's own. `lanesPerChannel`/`spawnInterval`/`depthMultiplier`
// default to buildings.js's own constants; only terrain's own width/depth/
// historyLength normally vary (the "largeur" slider, and the rock terrain's
// own defaults).
export function computeCellSize({
  terrainWidth,
  terrainDepth,
  terrainHistoryLength,
  lanesPerChannel = 32,
  spawnInterval = 4,
  depthMultiplier = 1.3,
}) {
  const depth = terrainDepth * depthMultiplier;
  const crossingFrames = terrainHistoryLength * depthMultiplier;
  const generationsPerLane = Math.round(crossingFrames / spawnInterval);
  const cellWidth = (terrainWidth / 2 / lanesPerChannel) * 0.85;
  const cellDepth = (depth / generationsPerLane) * 0.85;
  return { cellWidth, cellDepth };
}

export function buildProceduralGeometry(def, cellUnit = 1) {
  const radius = (def.radius ?? 0.35) * cellUnit;
  const segments = def.segments || (def.type === 'cylinder' ? 10 : 4);
  // 'cone' and any procedural type this build doesn't recognise fall back
  // to a cone rather than skipping the entry outright.
  const geometry = def.type === 'cylinder'
    ? new THREE.CylinderGeometry(radius, radius, 1, segments)
    : new THREE.ConeGeometry(radius, 1, segments);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

// Loads a def's .obj + its own .mtl (for its texture), merges its sub-mesh
// geometries into one, and normalizes it to the same "one unit tall,
// centred footprint, pivoted at the base" convention every shape uses --
// generalized to whatever bounding box the model actually has, instead of a
// hand-picked radius like the procedural shapes. Resolves { geometry,
// material }; rejects if the model has no meshes, or its sub-meshes can't
// be merged (mismatched attributes).
//
// `folder` + separate `obj`/`mtl` filenames rather than a single combined
// url: the .mtl's own texture reference is resolved relative to that folder
// by MTLLoader, and a model's embedded `mtllib` line can point at a
// filename that doesn't actually match what's on disk (true of the
// skull.obj this was first built against) -- loading the .mtl ourselves and
// handing it to OBJLoader.setMaterials sidesteps that mismatch entirely.
// Breaks a geometry that already has multiple material groups (one mesh,
// several usemtl switches inside it) into one single-material geometry per
// group -- see loadObjShape's own note on why every geometry handed to
// mergeGeometries(..., true) needs to be single-material first. OBJLoader's
// own output is non-indexed (group.start/count address vertices directly),
// handled by slicing each attribute's array to that range; the indexed case
// is handled too (slicing the index instead, attributes shared/uncopied)
// for robustness, though it hasn't come up in practice.
function splitByGroups(geometry) {
  if (!geometry.groups || geometry.groups.length === 0) {
    return [{ geometry, materialIndex: 0 }];
  }
  return geometry.groups.map((g) => {
    const sub = new THREE.BufferGeometry();
    if (geometry.index) {
      sub.setIndex(new THREE.BufferAttribute(geometry.index.array.slice(g.start, g.start + g.count), 1));
      for (const name in geometry.attributes) sub.setAttribute(name, geometry.attributes[name]);
    } else {
      for (const name in geometry.attributes) {
        const attr = geometry.attributes[name];
        const { itemSize } = attr;
        const slice = attr.array.slice(g.start * itemSize, (g.start + g.count) * itemSize);
        sub.setAttribute(name, new THREE.BufferAttribute(slice, itemSize, attr.normalized));
      }
    }
    return { geometry: sub, materialIndex: g.materialIndex || 0 };
  });
}

export function loadObjShape(def) {
  return new Promise((resolve, reject) => {
    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(def.folder);
    mtlLoader.load(
      def.mtl,
      (materials) => {
        materials.preload();
        const objLoader = new OBJLoader();
        objLoader.setMaterials(materials);
        objLoader.setPath(def.folder);
        objLoader.load(
          def.obj,
          (group) => {
            const pairs = [];
            const fallbackMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
            group.traverse((child) => {
              if (!child.isMesh || !child.geometry) return;
              const childMaterial = child.material || fallbackMaterial;
              const childMaterials = Array.isArray(childMaterial) ? childMaterial : [childMaterial];
              // A single Object3D from OBJLoader can itself already be
              // multi-material (its own geometry carries groups + a
              // matching material array -- true whenever the source .obj
              // has many usemtl switches inside one "g", which is common
              // for a model exported as one big object rather than one
              // part per material). splitByGroups below turns each of THAT
              // mesh's own groups into its own single-material geometry+
              // material pair, so nothing about a child's own internal
              // grouping gets lost before the material-bucketing step below.
              for (const { geometry: subGeometry, materialIndex } of splitByGroups(child.geometry)) {
                pairs.push({ geometry: subGeometry, material: childMaterials[materialIndex] || childMaterials[0] || fallbackMaterial });
              }
            });
            if (pairs.length === 0) { reject(new Error(`no meshes in ${def.obj}`)); return; }
            // Bucket every part by which material it actually uses, THEN
            // merge each bucket into one contiguous geometry, THEN merge
            // those (now one per distinct material, not one per original
            // export segment) with useGroups so each gets its own group --
            // a draw call is one per geometry group regardless of instance
            // count, so a model whose source file switched materials
            // hundreds of times over only a handful of actual colours
            // (mnogohome.obj: ~2700 segments, 10 materials) would otherwise
            // cost that many draw calls a frame for this one shape alone,
            // every frame, whether or not it's currently spawned anywhere.
            const byMaterial = new Map();
            for (const { geometry: partGeometry, material: partMaterial } of pairs) {
              if (!byMaterial.has(partMaterial)) byMaterial.set(partMaterial, []);
              byMaterial.get(partMaterial).push(partGeometry);
            }
            const uniqueMaterials = [...byMaterial.keys()];
            const perMaterialGeometries = uniqueMaterials.map((m) => {
              const parts = byMaterial.get(m);
              return parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
            });
            if (perMaterialGeometries.some((g) => !g)) { reject(new Error(`mismatched geometry attributes in ${def.obj}`)); return; }
            const merged = perMaterialGeometries.length > 1
              ? mergeGeometries(perMaterialGeometries, true)
              : perMaterialGeometries[0].clone();
            if (!merged) { reject(new Error(`mismatched geometry attributes in ${def.obj}`)); return; }
            const material = uniqueMaterials.length > 1 ? uniqueMaterials : uniqueMaterials[0];
            // Optional [x, y, z] degrees, for a model authored with a
            // different up axis than this system's Y-up (a common mismatch
            // for 3ds Max exports, which default to Z-up) -- applied before
            // the bounding-box normalization below so height/centring are
            // computed from the corrected orientation, not the raw one.
            if (Array.isArray(def.rotation)) {
              const [rx = 0, ry = 0, rz = 0] = def.rotation;
              if (rx) merged.rotateX(THREE.MathUtils.degToRad(rx));
              if (ry) merged.rotateY(THREE.MathUtils.degToRad(ry));
              if (rz) merged.rotateZ(THREE.MathUtils.degToRad(rz));
            }
            merged.computeBoundingBox();
            const box = merged.boundingBox;
            const rawWidth = box.max.x - box.min.x;
            const rawHeight = Math.max(box.max.y - box.min.y, 1e-6);
            const rawDepth = box.max.z - box.min.z;
            const centerX = (box.max.x + box.min.x) / 2;
            const centerZ = (box.max.z + box.min.z) / 2;
            merged.translate(-centerX, -box.min.y, -centerZ);
            merged.scale(1 / rawHeight, 1 / rawHeight, 1 / rawHeight);
            resolve({
              geometry: merged,
              material,
              // Bounding box in the model's own native units (before the
              // rotation/normalization above), and the same box after --
              // width/depth here are what actually matters day to day: once
              // normalized, height is always exactly 1, so a shape that's
              // e.g. 0.6 wide reads as "60% as wide as it is tall" and scales
              // accordingly wherever it's placed (see buildings.js's own
              // footprint-based uniform scale for .obj shapes). Handed back
              // mainly for shape-bench.js's own display -- buildings.js
              // itself only ever needs the final geometry.
              rawSize: { x: rawWidth, y: rawHeight, z: rawDepth },
              normalizedSize: { x: rawWidth / rawHeight, y: 1, z: rawDepth / rawHeight },
            });
          },
          undefined,
          reject,
        );
      },
      undefined,
      reject,
    );
  });
}
