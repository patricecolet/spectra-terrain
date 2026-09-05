uniform sampler2D uHeightMap;
uniform float uOffset;
uniform float uAmplitude;
uniform float uBassCenter; // 0.0 = valley in the middle (bass at the outer edges)
                            // 1.0 = bass in the middle (valley/treble at the outer edges)
uniform float uCurve;      // depth-axis bend, independent of the audio-driven height
uniform float uHalfDepth;  // plane's local half-depth, to normalise position.y for uCurve
uniform float uVibration;      // -1 soft/slow ripple .. 0 neutral (still) .. 1 hard/fast jitter
uniform float uVibrationLevel; // 0..1 broadband loudness -- drives the soft wave
uniform float uVibrationBass;  // 0..1 bass-only envelope -- drives the hard jitter
uniform float uVibrationSpatial; // <1 widens the ripple (bass-heavy sound right now), >1 tightens it (treble-heavy)
uniform float uVibrationTime;  // running clock, only for this ripple

varying vec2 vUv;
varying float vHeight;
varying vec3 vNormal;
varying float vFogDepth;

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

  // Vibration: an extra travelling wave riding on top of the audio-driven
  // height, so the surface itself seems to flow with the music instead of
  // the page shaking around it. Soft ("mou", uVibration < 0) tracks the
  // broadband level -- slow and wide, two low frequencies on different
  // axes/speeds so it reads as one wave breathing through the surface, not a
  // rigid tilt. Hard ("dur", uVibration > 0) tracks the bass envelope
  // instead of that same broadband level: bass barely moves between kicks,
  // so keying the fast jitter to it (rather than to uVibrationLevel, which
  // is what "mou" already uses) makes each hit visibly pop instead of
  // sitting at a near-constant, easy-to-miss amplitude.
  // The slider reaches full strength at 3/4 of its travel and holds there --
  // the last quarter reads as "too much" rather than "more", so it isn't
  // where the useful range lives.
  float softAmt = min(max(-uVibration, 0.0) / 0.75, 1.0) * uVibrationLevel;
  float hardAmt = min(max(uVibration, 0.0) / 0.75, 1.0) * uVibrationBass;
  // uVibrationSpatial scales both waves' spatial frequency, so whichever
  // frequencies are actually playing right now set the ripple's own size --
  // wide when the sound is bass-heavy, tight when it's treble-heavy --
  // independently of which of soft/hard is driving its amplitude.
  float sp = uVibrationSpatial;
  float softRipple = sin(position.x * 0.15 * sp + uVibrationTime * 1.1) * softAmt * 1.6
                    + sin(position.y * 0.12 * sp - uVibrationTime * 0.8) * softAmt * 1.2;
  float hardRipple = sin(position.x * 1.8 * sp + uVibrationTime * 24.0) * hardAmt * 0.7
                    + sin(position.y * 2.3 * sp - uVibrationTime * 31.0) * hardAmt * 0.6;
  float vibrationOffset = softRipple + hardRipple;

  vec3 displaced = position + vec3(0.0, 0.0, height + curveOffset + vibrationOffset);
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  vFogDepth = -mvPosition.z;
}
