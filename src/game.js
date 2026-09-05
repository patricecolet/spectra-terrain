import * as THREE from 'three';

const BALL_RADIUS = 0.6;
const BALL_SPEED = 7; // world units/sec toward the target
// Rise/run the ball can climb head-on. Beyond this, its desired direction is
// steered to keep only the tangential component (whichever side the target
// already leans toward), so it slides around the obstacle instead of trying
// to scale it -- "over the gentle slopes, around the steep ones" for free,
// out of the same slope-follow projection.
const MAX_CLIMB_SLOPE = 0.9;
const ARROW_STEP = 1.5; // world units the target moves per arrow key press
const MARGIN = 1.5; // keeps the ball off the terrain's own edge fade

// A ball that walks on the terrain's own live height field: arrow keys move
// a target point, the ball steers toward it every frame, climbing what it
// can and sliding around what it can't (see MAX_CLIMB_SLOPE). Independent of
// whatever the tuning panel does to the terrain's *visual* look -- it reads
// height straight from Terrain.sampleHeightAtWorld(), the same data the
// vertex shader displaces from.
export class Game {
  constructor({ scene, terrain }) {
    this.terrain = terrain;
    this.enabled = false;
    this.position = { x: 0, z: 0 };
    this.target = { x: 0, z: 0 };

    const geometry = new THREE.SphereGeometry(BALL_RADIUS, 20, 16);
    const material = new THREE.MeshLambertMaterial({ color: 0x8fd8ff });
    this.ball = new THREE.Mesh(geometry, material);
    this.ball.visible = false;
    scene.add(this.ball);

    // The terrain's own material does its lighting entirely inside its
    // shader, so this is the only light in the scene -- added just for the
    // ball, which would otherwise render pitch black under MeshLambertMaterial.
    this.light = new THREE.DirectionalLight(0xffffff, 1.2);
    this.light.position.set(3, 6, 7);
    this.light.visible = false;
    scene.add(this.light);

    window.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    const halfWidth = this.terrain.width / 2 - MARGIN;
    const halfDepth = this.terrain.depth / 2 - MARGIN;
    switch (e.key) {
      case 'ArrowLeft': this.target.x = Math.max(-halfWidth, this.target.x - ARROW_STEP); break;
      case 'ArrowRight': this.target.x = Math.min(halfWidth, this.target.x + ARROW_STEP); break;
      // Screen "up" is further away from the camera, i.e. more negative
      // world Z (see the depthNorm/world-Z convention in Terrain).
      case 'ArrowUp': this.target.z = Math.max(-halfDepth, this.target.z - ARROW_STEP); break;
      case 'ArrowDown': this.target.z = Math.min(halfDepth, this.target.z + ARROW_STEP); break;
      default: return;
    }
    e.preventDefault();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.ball.visible = enabled;
    this.light.visible = enabled;
    if (enabled) {
      this.position.x = 0;
      this.position.z = 0;
      this.target.x = 0;
      this.target.z = 0;
    }
  }

  update(dt) {
    if (!this.enabled) return;

    const dx = this.target.x - this.position.x;
    const dz = this.target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.01) {
      let dirX = dx / dist;
      let dirZ = dz / dist;

      const eps = 0.3;
      const hR = this.terrain.sampleHeightAtWorld(this.position.x + eps, this.position.z);
      const hL = this.terrain.sampleHeightAtWorld(this.position.x - eps, this.position.z);
      const hF = this.terrain.sampleHeightAtWorld(this.position.x, this.position.z + eps);
      const hB = this.terrain.sampleHeightAtWorld(this.position.x, this.position.z - eps);
      const dHdx = (hR - hL) / (2 * eps);
      const dHdz = (hF - hB) / (2 * eps);
      const gradLen = Math.hypot(dHdx, dHdz);

      if (gradLen > 1e-4) {
        const gx = dHdx / gradLen;
        const gz = dHdz / gradLen;
        const along = dirX * gx + dirZ * gz; // signed slope faced if moving straight toward the target
        const climb = along * gradLen;
        if (climb > MAX_CLIMB_SLOPE) {
          const allowedAlong = MAX_CLIMB_SLOPE / gradLen;
          const tanX = dirX - along * gx;
          const tanZ = dirZ - along * gz;
          const steerX = tanX + allowedAlong * gx;
          const steerZ = tanZ + allowedAlong * gz;
          const len = Math.hypot(steerX, steerZ) || 1;
          dirX = steerX / len;
          dirZ = steerZ / len;
        }
      }

      const step = Math.min(dist, BALL_SPEED * dt);
      this.position.x += dirX * step;
      this.position.z += dirZ * step;

      const halfWidth = this.terrain.width / 2 - MARGIN;
      const halfDepth = this.terrain.depth / 2 - MARGIN;
      this.position.x = Math.min(halfWidth, Math.max(-halfWidth, this.position.x));
      this.position.z = Math.min(halfDepth, Math.max(-halfDepth, this.position.z));
    }

    const height = this.terrain.sampleHeightAtWorld(this.position.x, this.position.z);
    this.ball.position.set(this.position.x, height + BALL_RADIUS, this.position.z);
  }
}
