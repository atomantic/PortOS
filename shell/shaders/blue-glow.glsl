// Blue glow - soft bloom around text with drifting blue nebula in background
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    // Bloom: sample neighbors and add glow
    vec2 px = vec2(1.0) / iResolution.xy;
    vec4 bloom = vec4(0.0);
    for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
            vec4 s = texture(iChannel0, uv + vec2(float(x), float(y)) * px * 1.5);
            float l = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (l > 0.15) bloom += s * 0.04;
        }
    }

    // Slow-drifting blue nebula in background areas
    float t = iTime * 0.08;
    vec2 p = uv * 3.0 + vec2(t, t * 0.7);
    float n = sin(p.x * 1.7 + sin(p.y * 2.3 + t)) *
              cos(p.y * 1.9 + sin(p.x * 1.3 - t * 0.5));
    n = n * 0.5 + 0.5;
    vec3 nebula = vec3(0.05, 0.12, 0.25) * n * 0.4;

    // Mask: only show nebula where terminal is dark
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 color = mix(nebula, term.rgb, mask) + bloom.rgb * vec3(0.4, 0.6, 1.0);
    fragColor = vec4(color, term.a);
}
