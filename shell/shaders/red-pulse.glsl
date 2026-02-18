// Red pulse - heartbeat vignette with subtle ember particles
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    // Heartbeat pulse - slow double-beat
    float t = iTime * 1.2;
    float beat = pow(sin(t) * 0.5 + 0.5, 8.0) +
                 pow(sin(t + 0.3) * 0.5 + 0.5, 12.0) * 0.5;
    beat *= 0.15;

    // Vignette centered glow
    vec2 center = uv - 0.5;
    float vignette = 1.0 - dot(center, center) * 1.5;
    vignette = clamp(vignette, 0.0, 1.0);

    // Rising ember particles in background
    float embers = 0.0;
    for (float i = 0.0; i < 8.0; i++) {
        vec2 pos = vec2(hash(vec2(i, 0.0)), fract(-iTime * 0.03 * (0.5 + hash(vec2(i, 1.0))) + hash(vec2(i, 2.0))));
        float d = length((uv - pos) * vec2(iResolution.x / iResolution.y, 1.0));
        embers += 0.0008 / (d * d + 0.001);
    }

    // Mask: only show effects where terminal is dark
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 glow = vec3(0.25, 0.04, 0.02) * beat * vignette;
    vec3 emberColor = vec3(1.0, 0.3, 0.1) * embers;
    vec3 bg = glow + emberColor * 0.3;

    vec3 color = mix(bg, term.rgb, mask);
    fragColor = vec4(color, term.a);
}
