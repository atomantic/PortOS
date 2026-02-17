// Purple nebula - drifting cosmic fog with twinkling stars
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec4 term = texture(iChannel0, uv);

    float t = iTime * 0.04;

    // Layered nebula
    float n1 = fbm(uv * 3.0 + vec2(t, t * 0.7));
    float n2 = fbm(uv * 5.0 - vec2(t * 0.5, t * 0.3));
    float nebula = n1 * 0.6 + n2 * 0.4;

    vec3 nebulaColor = mix(
        vec3(0.08, 0.02, 0.15),   // deep purple
        vec3(0.15, 0.05, 0.25),   // lighter purple
        nebula
    ) * 0.5;

    // Sparse twinkling stars
    float stars = 0.0;
    for (float i = 0.0; i < 12.0; i++) {
        vec2 pos = vec2(hash(vec2(i, 3.0)), hash(vec2(i, 7.0)));
        float d = length((uv - pos) * vec2(iResolution.x / iResolution.y, 1.0));
        float twinkle = sin(iTime * (1.0 + hash(vec2(i, 5.0)) * 2.0) + i) * 0.5 + 0.5;
        stars += (0.0003 / (d * d + 0.0005)) * twinkle;
    }

    // Mask: only in background areas
    float lum = dot(term.rgb, vec3(0.2126, 0.7152, 0.0722));
    float mask = smoothstep(0.05, 0.15, lum);

    vec3 bg = nebulaColor + vec3(0.7, 0.5, 1.0) * stars * 0.3;
    vec3 color = mix(bg, term.rgb, mask);
    fragColor = vec4(color, term.a);
}
