precision highp float;

varying vec2 vUv;
varying float vHeight;
varying vec3 vNormal;

uniform float uStyle; // 0 = smooth shading, 1 = drawn/toon banding with ink lines
uniform float uHueShift;   // -1 (green) .. 0 (neutral, the measured palette) .. 1 (blue)
uniform float uSaturation; // 0 (black & white) .. 1 (full colour, the measured palette)
uniform float uBrilliance; // -1 (soft glow) .. 0 (neutral) .. 1 (chrome/specular)

// Fog is applied by hand (mix toward uFogColor by camera distance) rather
// than through three.js's built-in material.fog wiring: that path calls
// WebGLRenderer's refreshFogUniforms() against whatever uniform slots the
// compiled program actually kept, and on this fully custom ShaderMaterial it
// threw (uniforms.fogColor undefined) every frame, killing the render loop.
// Signed like the three params above: -1 (see-through/ghost) .. 0 (neutral,
// no fog) .. 1 (dense fog, capped at the density this app used to carry as
// its one fixed "medium" look before it became a live control).
uniform vec3 uFogColor;
uniform float uFogAmount;
varying float vFogDepth;

void main() {
  // Palette measured directly from the album artwork (a star, drawn in
  // coloured pencil): each stop is the average of pixels picked out of that
  // image by hue. The drawing mixes a violet-red/crimson family in with its
  // plain reds — that hue gets its own stops here rather than being skipped
  // — and the red/orange side of the ramp gets more stops so that stretch is
  // gradual instead of just a couple of jumps, which also keeps the yellow
  // band (thin and easy to overrepresent) from dominating the top end. Same
  // ramp for both channels — amplitude alone drives colour, not which side
  // of the stereo field it's on.
  vec3 c0 = vec3(0.171, 0.005, 0.009); // darkest ember
  vec3 c1 = vec3(0.207, 0.028, 0.066); // violet-red ember
  vec3 c2 = vec3(0.475, 0.075, 0.063); // red
  vec3 c3 = vec3(0.523, 0.176, 0.247); // violet-red / crimson glow
  vec3 c4 = vec3(0.666, 0.265, 0.152); // red-orange
  vec3 c5 = vec3(0.710, 0.400, 0.214); // orange
  vec3 c6 = vec3(0.726, 0.500, 0.234); // orange-yellow
  vec3 c7 = vec3(0.807, 0.802, 0.894); // brightest highlight

  float h = clamp(vHeight, 0.0, 1.0);
  vec3 color = c0;
  color = mix(color, c1, smoothstep(0.0, 0.10, h));
  color = mix(color, c2, smoothstep(0.10, 0.24, h));
  color = mix(color, c3, smoothstep(0.24, 0.38, h));
  color = mix(color, c4, smoothstep(0.38, 0.52, h));
  color = mix(color, c5, smoothstep(0.52, 0.65, h));
  color = mix(color, c6, smoothstep(0.65, 0.80, h));
  color = mix(color, c7, smoothstep(0.80, 1.0, h));

  // Real slope-based shading instead of a flat, uniformly-lit "plastic"
  // surface: vNormal comes from the live height data (see vertex shader), so
  // the light/shadow on each ridge moves with the spectrum itself rather
  // than sitting on top of it like a static decal. Light direction is fixed
  // in view space, so it stays put relative to the camera under OrbitControls.
  vec3 light = normalize(vec3(0.35, 0.6, 0.75));
  float lambert = max(dot(normalize(vNormal), light), 0.0);
  float shadeSmooth = mix(0.62, 1.22, lambert);

  // "Drawn" variant: quantize the same lighting into flat bands with a thin
  // dark ink line at each step, like pencil cross-hatching read from a
  // distance -- still driven by the live normal, so it moves with the sound
  // instead of sitting on top of it like a fixed texture would.
  float b1 = 0.35, b2 = 0.6, b3 = 0.85, ew = 0.02;
  float t = 0.0;
  t = mix(t, 0.33, smoothstep(b1 - ew, b1 + ew, lambert));
  t = mix(t, 0.66, smoothstep(b2 - ew, b2 + ew, lambert));
  t = mix(t, 1.0, smoothstep(b3 - ew, b3 + ew, lambert));
  float shadeToon = mix(0.55, 1.3, t);
  float lw = 0.015;
  float lineDarken = max(
    1.0 - smoothstep(0.0, lw, abs(lambert - b1)),
    max(
      1.0 - smoothstep(0.0, lw, abs(lambert - b2)),
      1.0 - smoothstep(0.0, lw, abs(lambert - b3))
    )
  );
  shadeToon *= mix(1.0, 0.35, lineDarken);

  color *= mix(shadeSmooth, shadeToon, uStyle);

  // Coloration: swing the palette toward green or blue while keeping each
  // pixel's own luminance, so a full swing still reads as the same shape in
  // a different family of hues rather than a flat colour wash. uHueShift is
  // signed and 0 at the measured palette, matching uCurve's own "0 = as
  // authored" convention so the two can share a slider mapping when linked.
  float baseLuma = dot(color, vec3(0.299, 0.587, 0.114));
  vec3 greenTint = vec3(0.15, 0.85, 0.35) * baseLuma;
  vec3 blueTint = vec3(0.15, 0.45, 0.95) * baseLuma;
  color = mix(color, greenTint, max(-uHueShift, 0.0));
  color = mix(color, blueTint, max(uHueShift, 0.0));

  // Saturation: signed and 0 at the measured palette (already "fully
  // coloured" -- there was never a plain/neutral reading further up, so that
  // measured colour has to be the middle, not one end). Negative fades to
  // that pixel's own grey; positive pushes each channel further from it than
  // the source art ever was, for a hot/vivid pop instead of just "more of
  // the same".
  float satLuma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color, vec3(satLuma), max(-uSaturation, 0.0));
  color = mix(color, satLuma + (color - satLuma) * 1.6, max(uSaturation, 0.0));

  // Brilliance: a single-pass stand-in for two opposite finishes. Glow
  // (uBrilliance < 0) is a soft, even haze lifted uniformly across the whole
  // surface -- not gated by lambert, so it reads as the surface itself
  // radiating light rather than just its already-lit facets getting
  // brighter (which looks like glare, not a glow). Capped well short of
  // uBrilliance's own -1..0 range: pushed any further it wipes out the
  // palette into a flat pale wash, reading as a lighting glitch rather than
  // a glow. Chrome (uBrilliance > 0) adds a sharp specular glint off a fixed
  // approximate view direction (vNormal is already in view space, and the
  // camera looks down -Z there, so +Z stands in for "toward the eye").
  // Neutral (0) leaves colour untouched either way, so this only ever pulls
  // away from it.
  vec3 viewDirApprox = vec3(0.0, 0.0, 1.0);
  vec3 halfDir = normalize(light + viewDirApprox);
  float spec = pow(max(dot(normalize(vNormal), halfDir), 0.0), 50.0);
  float glowAmount = max(-uBrilliance, 0.0);
  vec3 glowed = mix(color + vec3(0.16, 0.13, 0.09), vec3(1.0), 0.12);
  color = mix(color, glowed, glowAmount * 0.65);
  color = mix(color, vec3(1.0), spec * max(uBrilliance, 0.0));

  // Fade the mesh's own geometric border to nothing so its rectangular edge
  // never reads as a hard cut against the backdrop image behind it — most
  // visible along the near edge ("en bas") but faded on all four sides so
  // it holds up across viewport sizes/aspect ratios.
  float edgeV = 0.05;
  float edgeU = 0.03;
  float fadeV = smoothstep(0.0, edgeV, vUv.y) * smoothstep(0.0, edgeV, 1.0 - vUv.y);
  float fadeU = smoothstep(0.0, edgeU, vUv.x) * smoothstep(0.0, edgeU, 1.0 - vUv.x);

  // Silence is transparent, not a flat dark shape sitting on top of the
  // artwork: near-zero amplitude shows the artwork straight through, then
  // opacity rushes up to the darkest ember within a thin sliver of signal
  // so the terrain still reads as solid as soon as there's anything to see.
  float silenceFade = smoothstep(0.0, 0.05, h);

  // Same falloff as three.js's FogExp2, capped at MAX_FOG_DENSITY (this
  // app's old fixed fog value, now repositioned as the top of the range
  // instead of its only setting).
  const float MAX_FOG_DENSITY = 0.025;
  float fogDensity = max(uFogAmount, 0.0) * MAX_FOG_DENSITY;
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  color = mix(color, uFogColor, fogFactor);

  // The other end isn't "less fog" (there's nowhere left for that to go) but
  // a different effect entirely: fade the terrain toward see-through so the
  // backdrop shows through it, like a ghost of itself rather than a solid.
  float transparency = max(-uFogAmount, 0.0);
  float alpha = fadeV * fadeU * silenceFade * mix(1.0, 0.15, transparency);

  gl_FragColor = vec4(color, alpha);
}
