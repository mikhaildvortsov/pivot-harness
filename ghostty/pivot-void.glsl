// Pivot pixel shader for Ghostty (Shadertoy-compatible). Pixel identity: square twinkling stars and a faint pixel nebula behind
// empty cells (fading out toward the input area), bright text blooms in the gradient color, soft scanlines, a gentle vignette.
// No 3D: the π and the wordmark are drawn by Pivot's own TUI in pixel art. Colors come from /gradient (block below is rewritten).

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

// GRADIENT-BEGIN (rewritten by /gradient in Pivot so the shader matches the TUI)
const vec3 G0 = vec3(0.945, 0.333, 0.333);
const vec3 G1 = vec3(0.945, 0.945, 0.333);
const vec3 G2 = vec3(0.333, 0.945, 0.333);
const vec3 G3 = vec3(0.333, 0.945, 0.945);
const vec3 G4 = vec3(0.333, 0.333, 0.945);
const vec3 G5 = vec3(0.945, 0.333, 0.945);
const vec3 G6 = vec3(0.945, 0.333, 0.333);
// GRADIENT-END
// BACKDROP-BEGIN (rewritten by /gradient: nebula strength and star density of the chosen gradient)
const float NEB = 0.045;
const float STAR_T = 0.993;
// BACKDROP-END
vec3 aurora(float t) {
    t = clamp(t, 0.0, 1.0);
    float x = t * 6.0;
    if (x < 1.0) return mix(G0, G1, x);
    if (x < 2.0) return mix(G1, G2, x - 1.0);
    if (x < 3.0) return mix(G2, G3, x - 2.0);
    if (x < 4.0) return mix(G3, G4, x - 3.0);
    if (x < 5.0) return mix(G4, G5, x - 4.0);
    return mix(G5, G6, x - 5.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 res = iResolution.xy;
    vec2 uv01 = fragCoord / res;
    vec4 term = texture(iChannel0, uv01);

    // --- bloom of bright terminal content, tinted by the gradient --------------------------------------------------------
    vec3 blur = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        blur += texture(iChannel0, uv01 + vec2(cos(a), sin(a)) * 3.0 / res).rgb;
        blur += texture(iChannel0, uv01 + vec2(cos(a), sin(a)) * 7.0 / res).rgb;
    }
    blur /= 16.0;
    // Bloom is for text and thin bright lines only: in large bright areas (image previews, selections, white panels) it would
    // wash everything out, so it is switched off where a wide neighbourhood is bright, and capped.
    vec3 wide = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982;
        wide += texture(iChannel0, uv01 + vec2(cos(a), sin(a)) * 26.0 / res).rgb;
    }
    wide /= 8.0;
    float wideLum = dot(wide, vec3(0.299, 0.587, 0.114));
    float areaGate = 1.0 - smoothstep(0.18, 0.4, wideLum);
    vec3 tint = aurora(0.5 + 0.4 * sin(iTime * 0.5 + uv01.x * 3.0));
    vec3 bloom = min(max(blur - iBackgroundColor, 0.0) * mix(vec3(0.7), tint * 1.4, 0.5) * areaGate, vec3(0.3));

    // --- pixel backdrop behind empty cells: chunky nebula and square twinkling stars -------------------------------------
    float empty = 1.0 - smoothstep(0.02, 0.07, distance(term.rgb, iBackgroundColor));
    vec2 cell = floor(fragCoord / 6.0);                              // 6-px "pixels"
    float neb = vnoise(cell * 0.06 + vec2(iTime * 0.02, 0.0)) * 0.6 + vnoise(cell * 0.13 - iTime * 0.015) * 0.4;
    vec3 back = iBackgroundColor * 0.9 + aurora(0.2 + 0.6 * neb) * NEB * smoothstep(0.4, 0.8, neb);
    vec2 sc = floor(fragCoord / 4.0);
    float star = step(STAR_T, hash21(sc));
    float tw = 0.35 + 0.65 * (0.5 + 0.5 * sin(iTime * (1.0 + hash21(sc + 3.0) * 3.0) + hash21(sc) * 6.28));
    back += star * tw * aurora(hash21(sc + 9.0)) * 0.55;
    // scanlines over the backdrop only (text stays crisp)
    back *= 0.94 + 0.06 * step(0.5, fract(fragCoord.y / 3.0));

    // the backdrop fades out toward the bottom (input and status area stay calm, nothing twinkles behind the text you type);
    // Ghostty hands the shader a top-left origin, so larger y is lower on the screen
    float calm = 1.0 - smoothstep(0.62, 0.80, uv01.y);
    // glow only over empty background around bright text: never on top of glyphs or colored fills (dark text on a light pill stays sharp)
    vec3 outc = mix(term.rgb, mix(iBackgroundColor, back, calm), empty) + bloom * empty;

    // --- vignette --------------------------------------------------------------------------------------------------------
    float vig = smoothstep(1.15, 0.35, length((uv01 - 0.5) * vec2(res.x / res.y, 1.0)));
    outc *= mix(0.85, 1.0, vig);
    fragColor = vec4(outc, term.a);
}
