// WHATWG Fetch "bad ports": browsers refuse to connect to these (ERR_UNSAFE_PORT),
// so a managed app bound to one has a UI nobody can open. Mirrors
// https://fetch.spec.whatwg.org/#port-blocking (Chrome and Firefox add X11's 6000
// to the list). Allocators must never hand one out.
export const BROWSER_UNSAFE_PORTS = Object.freeze(new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]));

export const isBrowserUnsafePort = (port) => BROWSER_UNSAFE_PORTS.has(port);
