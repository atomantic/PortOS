// Green rain - gentle matrix-like falling particles
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    // Grid of falling streaks
    float drops = 0.0;
    float cols = 40.0;
    for (float i = 0.0; i < cols; i++) {
        float x = (i + 0.5) / cols;
        float speed = 0.02 + hash(vec2(i, 0.0)) * 0.04;
        float phase = hash(vec2(i, 1.0));
        float y = fract(-iTime * speed + phase);

        // Streak with tail
        float dx = abs(uv.x - x) * cols;
        float dy = uv.y - y;
        if (dy > 0.0 && dy < 0.15 && dx < 0.5) {
            float brightness = (1.0 - dy / 0.15) * (1.0 - dx * 2.0);
            drops += brightness * 0.08;
        }
    }

    // Subtle green fog
    float t = iTime * 0.05;
    float fog = sin(uv.x * 4.0 + t) * cos(uv.y * 3.0 - t * 0.7) * 0.5 + 0.5;
    vec3 fogColor = vec3(0.02, 0.08, 0.03) * fog * 0.3;

    // Mask: only in background areas
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 rain = vec3(0.1, 0.9, 0.3) * drops;
    vec3 bg = fogColor + rain;

    vec3 color = mix(bg, term.rgb, mask);
    fragColor = vec4(color, term.a);
}
