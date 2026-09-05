import * as THREE from 'three';

const BALL_RADIUS = 0.6;
const BALL_SPEED = 7; // world units/sec toward the aim point
// Rise/run the ball can climb head-on. Beyond this, its desired direction is
// steered to keep only the tangential component (whichever side the aim
// point already leans toward), so it slides around the obstacle instead of
// trying to scale it -- "over the gentle slopes, around the steep ones" for
// free, out of the same slope-follow projection.
const MAX_CLIMB_SLOPE = 0.9;
const ARROW_STEP = 1.5; // world units the aim point moves per arrow key press
const MARGIN = 1.5; // keeps the ball and the goal off the terrain's own edge fade

const GOAL_RADIUS = 0.5;
const GOAL_HOVER = 0.9; // resting height above the terrain surface it's riding
const GOAL_BOB_AMPLITUDE = 0.25;
const GOAL_BOB_SPEED = 2.2;
const CAPTURE_RADIUS = BALL_RADIUS + GOAL_RADIUS + 0.3; // how close counts as "reached"

// A ball that walks on the terrain's own live height field: arrow keys move
// an aim point, the ball steers toward it every frame, climbing what it can
// and sliding around what it can't (see MAX_CLIMB_SLOPE). Independent of
// whatever the tuning panel does to the terrain's *visual* look -- it reads
// height straight from Terrain.sampleHeightAtWorld(), the same data the
// vertex shader displaces from.
//
// The goal is a separate marker, placeholder shape for now (an octahedron --
// swap this out once there's a real design for it): it stays at a fixed
// (x, z) but its own height rides the same live terrain, so it visibly moves
// with the music the same way the ball does. Reaching it scores a point and
// respawns it elsewhere.
export class Game {
  constructor({ scene, terrain }) {
    this.terrain = terrain;
    this.enabled = false;
    this.position = { x: 0, z: 0 };
    this.aim = { x: 0, z: 0 };
    this.score = 0;
    this.onScore = null; // (score) => void, set by the caller
    this._time = 0;

    const ballGeometry = new THREE.SphereGeometry(BALL_RADIUS, 20, 16);
    const ballMaterial = new THREE.MeshLambertMaterial({ color: 0x8fd8ff });
    this.ball = new THREE.Mesh(ballGeometry, ballMaterial);
    this.ball.visible = false;
    scene.add(this.ball);

    const goalGeometry = new THREE.OctahedronGeometry(GOAL_RADIUS, 0);
    const goalMaterial = new THREE.MeshLambertMaterial({ color: 0xffc94d });
    this.goal = new THREE.Mesh(goalGeometry, goalMaterial);
    this.goal.visible = false;
    scene.add(this.goal);
    this.goalPos = { x: 0, z: 0 };

    // The terrain's own material does its lighting entirely inside its
    // shader, so this is the only light in the scene -- added just for the
    // ball/goal, which would otherwise render pitch black under
    // MeshLambertMaterial.
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
      case 'ArrowLeft': this.aim.x = Math.max(-halfWidth, this.aim.x - ARROW_STEP); break;
      case 'ArrowRight': this.aim.x = Math.min(halfWidth, this.aim.x + ARROW_STEP); break;
      // Screen "up" is further away from the camera, i.e. more negative
      // world Z (see the depthNorm/world-Z convention in Terrain).
      case 'ArrowUp': this.aim.z = Math.max(-halfDepth, this.aim.z - ARROW_STEP); break;
      case 'ArrowDown': this.aim.z = Math.min(halfDepth, this.aim.z + ARROW_STEP); break;
      default: return;
    }
    e.preventDefault();
  }

  _randomizeGoal() {
    const halfWidth = this.terrain.width / 2 - MARGIN;
    const halfDepth = this.terrain.depth / 2 - MARGIN;
    // Re-roll once if it would land right on the ball -- a spawn a player
    // instantly overlaps reads as broken, not lucky.
    for (let i = 0; i < 2; i++) {
      const x = (Math.random() * 2 - 1) * halfWidth;
      const z = (Math.random() * 2 - 1) * halfDepth;
      if (Math.hypot(x - this.position.x, z - this.position.z) > CAPTURE_RADIUS * 2) {
        this.goalPos.x = x;
        this.goalPos.z = z;
        return;
      }
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.ball.visible = enabled;
    this.goal.visible = enabled;
    this.light.visible = enabled;
    if (enabled) {
      this.position.x = 0;
      this.position.z = 0;
      this.aim.x = 0;
      this.aim.z = 0;
      this.score = 0;
      if (this.onScore) this.onScore(this.score);
      this._randomizeGoal();
    }
  }

  update(dt) {
    if (!this.enabled) return;
    this._time += dt;

    const dx = this.aim.x - this.position.x;
    const dz = this.aim.z - this.position.z;
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
        const along = dirX * gx + dirZ * gz; // signed slope faced if moving straight toward the aim point
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

    const goalHeight = this.terrain.sampleHeightAtWorld(this.goalPos.x, this.goalPos.z);
    const bob = Math.sin(this._time * GOAL_BOB_SPEED) * GOAL_BOB_AMPLITUDE;
    this.goal.position.set(this.goalPos.x, goalHeight + GOAL_HOVER + bob, this.goalPos.z);
    this.goal.rotation.y += dt * 1.4;

    if (Math.hypot(this.position.x - this.goalPos.x, this.position.z - this.goalPos.z) < CAPTURE_RADIUS) {
      this.score++;
      if (this.onScore) this.onScore(this.score);
      this._randomizeGoal();
    }
  }
}
