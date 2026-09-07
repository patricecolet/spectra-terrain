precision highp float;

// Raymarched "buildings" look for the spectral terrain -- same underlying
// idea as the original find (SDF boxes marched per-pixel), rewritten to
// plug directly into this app's own model instead of carrying its own fake
// camera and infinite repeating tunnel:
//
// - The ray for each pixel comes from the REAL three.js camera (uInverseProjection
//   + uCameraWorldMatrix), so OrbitControls drives this exactly like the rock
//   terrain's own camera -- no separate scripted flythrough.
// - The city is bounded to (uWidth x uDepth), the same footprint the rock
//   terrain's mesh occupies, not an infinite grid.
// - Buildings sit at FIXED grid positions (like a terrain vertex), and their
//   height comes from uHeightMap via the exact same continuously-scrolling
//   bin/channel/mirror lookup terrain.vert.glsl's sampleHeightValue() uses
//   (uOffset). Data flows THROUGH the fixed grid over time -- the same way
//   the spectrogram visibly flows toward the camera across the rock
//   terrain's own fixed mesh -- rather than the buildings themselves sliding
//   through a fixed window. An earlier version tried the latter (freezing
//   each building's height, moving its position instead) to avoid individual
//   buildings visibly growing/shrinking; the growing/shrinking is actually
//   the point -- it's what "the music flowing past" looks like on a rigid
//   grid -- and freezing it also silently killed any actual motion.

uniform vec2 resolution;
uniform float time;

uniform mat4 uInverseProjection;
uniform mat4 uCameraWorldMatrix;

uniform sampler2D uHeightMap; // R = left channel, G = right channel -- terrain.js's own convention
uniform float uOffset; // same scrolling texture-offset convention as terrain.js's own uOffset
uniform float uHistoryLength; // rows in uHeightMap -- see sampleHeight()'s row-snapping
uniform float uBassCenter;
uniform float uAmplitude;
uniform float uWidth;
uniform float uDepth;
uniform float uBuildingCols; // how many building "lanes" span uWidth
uniform float uBuildingRows; // how many span uDepth

// Per-bin average amplitude, precomputed offline over the whole track (see
// buildings-test.js's profile capture/export) -- one texel per bin, same
// value in both channels. Lets a bin be judged against its OWN typical level
// instead of one global threshold, so a bin that's quietly average all
// through the track doesn't draw a cube just because it's non-zero.
uniform sampler2D uProfile;
uniform float uHasProfile; // 0 or 1 -- no profile loaded yet still renders everything
uniform float uProfileThreshold; // 0..1 -- below this fraction of its own average, skip the cube

float maxcomp(in vec3 p) { return max(p.x, max(p.y, p.z)); }

vec2 sdBox(vec3 p, vec3 b) {
	vec3 di = abs(p) - b;
	float mc = maxcomp(di);
	return vec2(min(mc, length(max(di, 0.0))), 1.0);
}

vec2 objUnion(vec2 d1, vec2 d2) { return d1.x < d2.x ? d1 : d2; }

float rand(vec2 n) {
	return 0.5 + 0.5 * fract(sin(dot(n, vec2(12.9898, 78.233))) * 43758.5453);
}

// Same left/right mirrored bin lookup terrain.vert.glsl's sampleHeightValue()
// uses -- factored out so both the live height read and the profile-gate
// check below can share it. y = 1.0 for left, 0.0 for right (a bool doesn't
// pack into a vec2).
vec2 binCoord(float worldX) {
	float u = 0.5 + worldX / uWidth;
	bool isLeft = u < 0.5;
	float localU = isLeft ? (u / 0.5) : ((u - 0.5) / 0.5);
	float sampleU = isLeft ? mix(localU, 1.0 - localU, uBassCenter) : mix(1.0 - localU, localU, uBassCenter);
	return vec2(sampleU, isLeft ? 1.0 : 0.0);
}

// Snapped to the nearest history row, not blended between two: one row is
// written per rendered frame (see buildings-test.js, same cadence as
// terrain.js's own update()) and never touched again once written, so a row
// is permanently stable once committed. Snapping means a cell reads that one
// exact, unchanging value for its entire dwell time instead of continuously
// blending toward whichever row is next -- a peak holds a truly constant
// height for the whole time it's "at" a given cell, changing only at the
// handoff to the next row. Also returns the raw (pre-uAmplitude) value in .y
// for the profile-gate check in buildingField().
vec2 sampleHeight(vec2 worldXZ) {
	vec2 bc = binCoord(worldXZ.x);
	float v = fract(0.5 - worldXZ.y / uDepth + uOffset);
	float row = floor(v * uHistoryLength);
	float vSnapped = (row + 0.5) / uHistoryLength;
	vec4 texel = texture2D(uHeightMap, vec2(bc.x, vSnapped));
	float raw = bc.y > 0.5 ? texel.r : texel.g;
	return vec2(raw * uAmplitude, raw);
}

vec2 floorPlane(vec3 p) {
	return vec2(p.y, 0.0);
}

// A fixed grid of boxes, one per (bin lane, depth slot) -- same footprint the
// rock terrain's mesh occupies. Nothing here moves; the *data* flowing
// through uOffset is what reads as the spectrum advancing toward the camera,
// exactly like the terrain's own scroll.
vec2 buildingField(vec3 p) {
	float halfW = uWidth * 0.5;
	float halfD = uDepth * 0.5;
	if (p.x < -halfW || p.x > halfW || p.z < -halfD || p.z > halfD) {
		return vec2(1000.0, 0.0); // outside the city footprint -- floor only
	}

	float cellW = uWidth / uBuildingCols;
	float cellD = uDepth / uBuildingRows;
	float col = floor((p.x + halfW) / cellW);
	float row = floor((p.z + halfD) / cellD);
	float cellCenterX = -halfW + (col + 0.5) * cellW;
	float cellCenterZ = -halfD + (row + 0.5) * cellD;

	vec2 sampled = sampleHeight(vec2(cellCenterX, cellCenterZ));

	if (uHasProfile > 0.5) {
		vec2 bc = binCoord(cellCenterX);
		vec4 pTexel = texture2D(uProfile, vec2(bc.x, 0.5));
		float avg = max(bc.y > 0.5 ? pTexel.r : pTexel.g, 0.02);
		if (sampled.y / avg < uProfileThreshold) {
			return vec2(1000.0, 0.0); // at or below this bin's own typical level -- no cube
		}
	}

	// A small nub even near silence, so quiet stretches still read as low
	// buildings rather than gaps in the grid.
	float height = max(sampled.x, 0.15);
	float jitter = 0.75 + rand(vec2(col, row)) * 0.2; // per-cell footprint variety
	vec3 q = p - vec3(cellCenterX, height * 0.5, cellCenterZ);
	vec3 halfExtents = vec3(cellW * 0.5 * jitter * 0.8, height * 0.5, cellD * 0.5 * jitter * 0.8);
	vec2 body = sdBox(q, halfExtents);
	return vec2(body.x, height); // .y carries the height through for colouring
}

vec2 distanceField(vec3 p) {
	return objUnion(floorPlane(p), buildingField(p));
}

vec4 applyFog(in vec4 currColor, in vec3 ray) {
	float rayLength = length(ray);
	float fogAmount = 1.0 - exp(-rayLength * 0.015);
	// Alpha 0 -- distant geometry fades to transparent, same as the sky it
	// fades into, so the page behind the canvas shows through instead of an
	// opaque haze.
	vec4 fogColor = vec4(0.5, 0.55, 0.65, 0.0);
	return mix(currColor, fogColor, fogAmount);
}

void main(void) {
	vec2 ndc = 2.0 * gl_FragCoord.xy / resolution.xy - 1.0;
	vec4 clipPos = vec4(ndc, -1.0, 1.0);
	vec4 viewDir = uInverseProjection * clipPos;
	viewDir = vec4(viewDir.xy, -1.0, 0.0);
	vec3 rayDir = normalize((uCameraWorldMatrix * viewDir).xyz);
	vec3 rayOrigin = uCameraWorldMatrix[3].xyz;

	const float MAX_DEPTH = 200.0;
	const int MAX_STEPS = 96;
	const float MIN_DIST = 0.01;

	vec2 dist = vec2(0.0);
	float totalDist = 0.0;
	vec3 p = rayOrigin;
	int steps = 0;
	for (int i = 0; i < MAX_STEPS; i++) {
		steps++;
		totalDist += dist.x * 0.8;
		p = rayOrigin + rayDir * totalDist;
		dist = distanceField(p);
		if (abs(dist.x) < MIN_DIST || totalDist > MAX_DEPTH) break;
	}

	vec4 finalColor = vec4(0.0); // nothing hit -- fully transparent

	if (totalDist < MAX_DEPTH) {
		vec3 e = vec3(0.01, 0.0, 0.0);
		vec3 n = normalize(vec3(
			dist.x - distanceField(p - e.xyy).x,
			dist.x - distanceField(p - e.yxy).x,
			dist.x - distanceField(p - e.yyx).x
		));

		vec3 baseColor;
		if (dist.y == 0.0) {
			baseColor = vec3(0.16, 0.17, 0.2); // floor
		} else {
			float t = clamp(dist.y / max(uAmplitude, 0.001), 0.0, 1.0);
			vec3 low = vec3(0.25, 0.28, 0.34);
			vec3 high = vec3(0.85, 0.9, 1.0);
			baseColor = mix(low, high, t);
			// Coarse window bands, cheap and legible from a distance instead of
			// a full brick texture -- a follow-up if this look earns its keep.
			float band = step(0.6, fract(p.y * 2.2));
			baseColor = mix(baseColor, baseColor * 1.4, band * 0.4);
		}

		vec3 lightDir = normalize(vec3(0.4, 0.7, 0.3));
		float diffuse = clamp(dot(n, lightDir), 0.15, 1.0);
		finalColor = vec4(baseColor * diffuse, 1.0);
	}

	finalColor = applyFog(finalColor, p - rayOrigin);
	gl_FragColor = finalColor;
}
