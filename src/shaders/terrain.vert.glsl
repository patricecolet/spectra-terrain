uniform sampler2D uHeightMap;
uniform float uOffset;
uniform float uAmplitude;
uniform float uBassCenter; // 0.0 = valley in the middle (bass at the outer edges)
                            // 1.0 = bass in the middle (valley/treble at the outer edges)
uniform float uCurve;      // depth-axis bend, independent of the audio-driven height
uniform float uHalfDepth;  // plane's local half-depth, to normalise position.y for uCurve

varying vec2 vUv;
varying float vHeight;
varying vec3 vNormal;

// Same height lookup as the main sample below, factored out so it can be
// re-run at neighbouring uvs to build a real surface normal (see main()).
float sampleHeightValue(vec2 uv2) {
  bool isLeft2 = uv2.x < 0.5;
  float localU2 = isLeft2 ? (uv2.x / 0.5) : ((uv2.x - 0.5) / 0.5);
  float sampleU2 = isLeft2
    ? mix(localU2, 1.0 - localU2, uBassCenter)
    : mix(1.0 - localU2, localU2, uBassCenter);
  vec4 texel2 = texture2D(uHeightMap, vec2(sampleU2, uv2.y + uOffset));
  return isLeft2 ? texel2.r : texel2.g;
}

void main() {
  vUv = uv;

  float value = sampleHeightValue(uv);
  float height = value * uAmplitude;
  vHeight = value;

  // Parabolic bend along depth (local Y here, world "up" once combined with
  // height below) -- a still, audio-independent curve on top of which the
  // spectrum plays out, e.g. lifting the far/near edges into a bowl.
  float depthNorm = uHalfDepth > 0.0 ? position.y / uHalfDepth : 0.0;
  float curveOffset = uCurve * depthNorm * depthNorm;

  // Real surface normal from neighbouring samples of the *same* live data,
  // instead of a flat per-facet normal (the "plastic" look) or a texture
  // overlay that doesn't move with the spectrum. Because it's derived from
  // the height map every frame, the shading it drives moves with the sound.
  float eps = 1.0 / 128.0;
  float hR = sampleHeightValue(uv + vec2(eps, 0.0)) * uAmplitude;
  float hL = sampleHeightValue(uv - vec2(eps, 0.0)) * uAmplitude;
  float hU = sampleHeightValue(uv + vec2(0.0, eps)) * uAmplitude;
  float hD = sampleHeightValue(uv - vec2(0.0, eps)) * uAmplitude;
  float dHdu = (hR - hL) * 0.5;
  float dHdv = (hU - hD) * 0.5;
  float normalStrength = 7.0;
  vec3 localNormal = normalize(vec3(-dHdu * normalStrength, -dHdv * normalStrength, 1.0));
  vNormal = normalize(normalMatrix * localNormal);

  vec3 displaced = position + vec3(0.0, 0.0, height + curveOffset);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
