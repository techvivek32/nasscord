/* Deterministic pseudo-values for demo rows that have no server data (scanner, watchlist, option chains).
   Same input, same output on server and client, so nothing flickers on hydration. */

export function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** Unit value in [0, 1) derived from a seed and an index. */
export function unit(seed: number, i: number) {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function between(seed: number, i: number, min: number, max: number, digits = 2) {
  const v = min + unit(seed, i) * (max - min);
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function pseudoSpark(symbol: string, n = 24) {
  const seed = hashSeed(symbol);
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v += (unit(seed, i) - 0.47) * 1.4;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

export function pseudoPrice(symbol: string) {
  return between(hashSeed(symbol), 1, 18, 640, 2);
}

export function pseudoChangePct(symbol: string) {
  return between(hashSeed(symbol), 2, -2.4, 2.6, 2);
}
