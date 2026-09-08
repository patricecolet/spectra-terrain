import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fetchShapeLibrary, buildProceduralGeometry, loadObjShape, computeCellSize } from './shapeLibrary.js';

// Mirrors terrain.js's own constructor defaults (width/depth/historyLength)
// -- the real app's "largeur" slider (10-60) and the window's own aspect
// ratio move terrain.width live, so this is necessarily an estimate at a
// representative size, not a guaranteed match to whatever the live scene
// currently has -- see the note where CELL is used below.
const CELL = computeCellSize({ terrainWidth: 24, terrainDepth: 48, terrainHistoryLength: 256 });

// Standalone viewer/editor for public/building-shapes.json: no audio, no
// lane grid, no random ilot rolls to wait out -- pick a shape from the list
// and see exactly what buildings.js would spawn for it (same
// shapeLibrary.js code builds both), including a real .obj's texture, at a
// size you can actually orbit around and inspect up close. The editor panel
// on the right tweaks a shape's own fields live (re-rendering immediately)
// and can download the result -- see saveBtn's own note on why that's a
// download rather than writing the file directly.

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101018);
scene.fog = new THREE.Fog(0x101018, 4, 14);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(2.4, 1.8, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);
controls.enableDamping = true;
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.1));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.3);
dirLight.position.set(3, 6, 4);
scene.add(dirLight);

// Red/green/blue = X/Y/Z (three.js's own convention) -- here specifically
// so a rotation field can be dialled in by what's actually needed ("the top
// of the model is pointing down the blue axis, so it needs -90 on red") on
// a model whose own up axis doesn't match this scene's Y-up, rather than by
// trial and error.
scene.add(new THREE.AxesHelper(1.4));

// A reference grid at the shape's own base scale (see SCALE below), so the
// footprint a real ilot would take up is visible alongside the shape
// itself, not just the shape floating in a void.
scene.add(new THREE.GridHelper(6, 12, 0x445566, 0x223344));

// Every shape in the library is authored "one unit tall" (see
// shapeLibrary.js's own note) -- blown up here purely so it fills a
// comfortable chunk of the view instead of sitting a metre from the camera.
const SCALE = 1.6;

let current = null;
function showMesh(geometry, material) {
  if (current) {
    scene.remove(current);
    current.geometry.dispose();
  }
  current = new THREE.Mesh(geometry, material);
  current.scale.set(SCALE, SCALE, SCALE);
  scene.add(current);
}

const listEl = document.getElementById('shape-list');
const infoEl = document.getElementById('shape-info');
const editorEl = document.getElementById('editor');
const editorName = document.getElementById('editor-name');
const editorVertexInfo = document.getElementById('editor-vertexinfo');
const editorDims = document.getElementById('editor-dims');
const editorProcedural = document.getElementById('editor-procedural');
const editorObj = document.getElementById('editor-obj');
const fWidth = document.getElementById('f-width');
const fDepth = document.getElementById('f-depth');
const fChance = document.getElementById('f-chance');
const fRadius = document.getElementById('f-radius');
const fSegments = document.getElementById('f-segments');
const fRotX = document.getElementById('f-rot-x');
const fRotY = document.getElementById('f-rot-y');
const fRotZ = document.getElementById('f-rot-z');
const fCapacity = document.getElementById('f-capacity');
const saveBtn = document.getElementById('save-btn');

let shapes = [];
let currentDef = null;
let currentBtn = null;

function describe(def, extra = '') {
  const bits = [
    `${def.name}`,
    `type: ${def.type}`,
    `taille: ${def.width}x${def.depth}`,
    `chance: ${def.chance}`,
  ];
  if (def.type === 'obj') bits.push(`capacité: ${def.capacity ?? 16}`);
  return bits.join(' · ') + (extra ? ` · ${extra}` : '');
}

const fmt = (n) => n.toFixed(2);

// How this shape's model would actually measure once buildings.js sizes it
// for its own ilot (see buildings.js's own footprint-based uniform scale for
// .obj shapes) -- computed at rest (no live "largeur" stretch, no
// end-of-life shrink) against CELL's representative cell size, so it's a
// ballpark for "does this width/depth choice fit the model's own
// proportions", not a live readout of the actual running scene.
function describeFit(def, normalizedSize) {
  const boxW = def.width * CELL.cellWidth;
  const boxD = def.depth * CELL.cellDepth;
  const footprint = (def.width * CELL.cellWidth + def.depth * CELL.cellDepth) / 2;
  const objW = footprint * normalizedSize.x;
  const objD = footprint * normalizedSize.z;
  const fitW = Math.round((objW / boxW) * 100);
  const fitD = Math.round((objD / boxD) * 100);
  return `à l'échelle (îlot ${def.width}x${def.depth}, réglages par défaut) : largeur ${fitW}%, profondeur ${fitD}% de la case`
    + ' -- 100% = remplit tout juste la case sur cet axe, en dessous ça flotte dedans, au-dessus ça déborde sur les voisines';
}

// Rebuilds/redisplays the 3D preview for a def -- separate from selectShape
// so an in-place edit (see wireEditor) can refresh the shape without
// touching the list's active button or re-populating the form under the
// user's cursor.
function renderShape(def) {
  infoEl.textContent = describe(def, def.type === 'obj' ? 'chargement…' : '');
  if (def.type === 'obj') {
    loadObjShape(def)
      .then(({ geometry, material, rawSize, normalizedSize }) => {
        showMesh(geometry, material);
        infoEl.textContent = describe(def, `${geometry.attributes.position.count} sommets`);
        editorVertexInfo.textContent = `${geometry.attributes.position.count} sommets`;
        editorDims.textContent = `dimensions natives (modèle) : ${fmt(rawSize.x)} x ${fmt(rawSize.y)} x ${fmt(rawSize.z)}\n`
          + `normalisées (hauteur = 1) : ${fmt(normalizedSize.x)} x 1 x ${fmt(normalizedSize.z)}\n`
          + describeFit(def, normalizedSize);
      })
      .catch((err) => {
        infoEl.textContent = describe(def, `erreur: ${err.message}`);
        editorVertexInfo.textContent = `erreur: ${err.message}`;
        editorDims.textContent = '';
      });
  } else {
    const geometry = buildProceduralGeometry(def, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0x8fa8c9, flatShading: true });
    showMesh(geometry, material);
    editorVertexInfo.textContent = '';
    editorDims.textContent = '';
  }
}

function populateEditor(def) {
  editorEl.hidden = false;
  editorName.textContent = def.name;
  fWidth.value = def.width;
  fDepth.value = def.depth;
  fChance.value = def.chance;
  const isObj = def.type === 'obj';
  editorProcedural.hidden = isObj;
  editorObj.hidden = !isObj;
  if (isObj) {
    const [rx = 0, ry = 0, rz = 0] = def.rotation || [];
    fRotX.value = rx;
    fRotY.value = ry;
    fRotZ.value = rz;
    fCapacity.value = def.capacity ?? 16;
  } else {
    fRadius.value = def.radius ?? 0.35;
    fSegments.value = def.segments ?? (def.type === 'cylinder' ? 10 : 4);
  }
}

function selectShape(def, btn) {
  if (currentBtn) currentBtn.classList.remove('active');
  btn.classList.add('active');
  currentBtn = btn;
  currentDef = def;
  populateEditor(def);
  renderShape(def);
}

// Every field edit mutates currentDef directly (the same object sitting in
// the `shapes` array, so saveBtn's download picks it up with no extra
// bookkeeping) and re-renders immediately -- a live preview of the exact
// change, not just a value sitting in a form.
function wireEditor() {
  const int = (input, fallback) => {
    const v = Math.round(Number(input.value));
    return Number.isFinite(v) ? v : fallback;
  };
  const float = (input, fallback) => {
    const v = Number(input.value);
    return Number.isFinite(v) ? v : fallback;
  };

  fWidth.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.width = int(fWidth, currentDef.width);
    currentBtn.textContent = `${currentDef.name} (${currentDef.width}x${currentDef.depth})`;
    renderShape(currentDef); // the fit%/footprint readout depends on width too
  });
  fDepth.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.depth = int(fDepth, currentDef.depth);
    currentBtn.textContent = `${currentDef.name} (${currentDef.width}x${currentDef.depth})`;
    renderShape(currentDef); // the fit%/footprint readout depends on depth too
  });
  fChance.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.chance = float(fChance, currentDef.chance);
  });
  fRadius.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.radius = float(fRadius, currentDef.radius);
    renderShape(currentDef);
  });
  fSegments.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.segments = int(fSegments, currentDef.segments);
    renderShape(currentDef);
  });
  const onRotationInput = () => {
    if (!currentDef) return;
    currentDef.rotation = [float(fRotX, 0), float(fRotY, 0), float(fRotZ, 0)];
    renderShape(currentDef);
  };
  fRotX.addEventListener('input', onRotationInput);
  fRotY.addEventListener('input', onRotationInput);
  fRotZ.addEventListener('input', onRotationInput);
  fCapacity.addEventListener('input', () => {
    if (!currentDef) return;
    currentDef.capacity = int(fCapacity, currentDef.capacity);
  });

  // The dev server only serves files, it can't write them -- this downloads
  // the edited library so it can be dropped into public/building-shapes.json
  // by hand, the same "export, then move the file into place" flow
  // buildings-test.js already uses for its own profile JSONs.
  saveBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ shapes }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'building-shapes.json';
    a.click();
    URL.revokeObjectURL(url);
  });
}
wireEditor();

fetchShapeLibrary().then((loaded) => {
  if (loaded.length === 0) {
    infoEl.textContent = 'aucune forme trouvée (building-shapes.json manquant ou invalide)';
    return;
  }
  shapes = loaded;
  shapes.forEach((def) => {
    const btn = document.createElement('button');
    btn.textContent = `${def.name} (${def.width}x${def.depth})`;
    btn.addEventListener('click', () => selectShape(def, btn));
    listEl.appendChild(btn);
  });
  selectShape(shapes[0], listEl.firstChild);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
