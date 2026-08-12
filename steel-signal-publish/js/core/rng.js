// STEEL SIGNAL — seeded RNG (mulberry32). Contract: export function rng(seed) -> () => float
// Deterministic: same seed always yields the same sequence. Returns floats in [0, 1).

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
