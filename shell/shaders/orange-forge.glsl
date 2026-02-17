// Orange forge - warm heat distortion with floating sparks
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    float t = iTime * 0.06;

    // Warm undulating heat
    float heat = sin(uv.x * 5.0 + t * 2.0) * cos(uv.y * 4.0 - t) * 0.5 + 0.5;
    heat *= sin(uv.y * 8.0 + t * 1.5) * 0.5 + 0.5;
    vec3 heatColor = mix(
        vec3(0.12, 0.06, 0.01),
        vec3(0.2, 0.1, 0.02),
        heat
    ) * 0.4;

    // Rising sparks
    float sparks = 0.0;
    for (float i = 0.0; i < 10.0; i++) {
        float x = hash(vec2(i, 0.0));
        float speed = 0.015 + hash(vec2(i, 1.0)) * 0.03;
        float y = fract(-iTime * speed + hash(vec2(i, 2.0)));
        float wobble = sin(iTime * 2.0 + i * 3.0) * 0.01;
        vec2 pos = vec2(x + wobble, y);
        float d = length((uv - pos) * vec2(iResolution.x / iResolution.y, 1.0));
        float life = y;  // fade as they rise
        sparks += (0.0004 / (d * d + 0.0003)) * life;
    }

    // Mask
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 sparkColor = vec3(1.0, 0.6, 0.15) * sparks * 0.4;
    vec3 bg = heatColor + sparkColor;
    vec3 color = mix(bg, term.rgb, mask);
    fragColor = vec4(color, term.a);
}
