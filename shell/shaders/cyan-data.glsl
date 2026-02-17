// Cyan data - flowing data streams with grid pattern
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    float t = iTime * 0.05;

    // Subtle grid overlay
    vec2 grid = fract(uv * vec2(30.0, 20.0));
    float gridLine = step(0.96, grid.x) + step(0.96, grid.y);
    vec3 gridColor = vec3(0.0, 0.15, 0.15) * gridLine * 0.15;

    // Horizontal data streams
    float streams = 0.0;
    for (float i = 0.0; i < 6.0; i++) {
        float y = hash(vec2(i, 0.0));
        float speed = 0.1 + hash(vec2(i, 1.0)) * 0.15;
        float x = fract(iTime * speed + hash(vec2(i, 2.0)));
        float width = 0.003 + hash(vec2(i, 3.0)) * 0.005;

        float dy = abs(uv.y - y);
        float dx = uv.x - x;
        if (dy < width && dx > -0.2 && dx < 0.0) {
            float brightness = (1.0 + dx / 0.2) * (1.0 - dy / width);
            streams += brightness * 0.15;
        }
    }

    // Soft cyan ambient
    float ambient = sin(uv.x * 3.0 + t) * sin(uv.y * 2.0 - t * 0.6) * 0.5 + 0.5;
    vec3 ambientColor = vec3(0.02, 0.08, 0.08) * ambient * 0.3;

    // Mask
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 streamColor = vec3(0.2, 1.0, 0.9) * streams;
    vec3 bg = ambientColor + gridColor + streamColor;
    vec3 color = mix(bg, term.rgb, mask);
    fragColor = vec4(color, term.a);
}
