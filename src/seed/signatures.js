// Demo "signatures": scribbles drawn as SVG paths for the fake staff and director of the public demo. They spell
// nothing and belong to nobody; no image file is committed. Every number is at most three digits (the scan's
// Aadhaar / mobile-number rules can never match path data). Ink is the Kinfolk palette's ink (docs/DESIGN-SYSTEM.md).

const INK = '#1E3446';

/** A deterministic wavy scribble: n loops across a 300 x 90 box. */
function scribble(seed, n) {
  let s = seed;
  const r = () => { s = (s * 197 + 61) % 991; return s / 991; };
  let x = 18, y = 55;
  const parts = [`M${x} ${y}`];
  for (let i = 0; i < n; i++) {
    const up = 18 + Math.round(r() * 26), w = 16 + Math.round(r() * 18);
    parts.push(`C${x + 4} ${y - up} ${x + w - 4} ${y - up} ${x + w} ${y}`);
    x += w;
    parts.push(`S${x + 10} ${y + 12 + Math.round(r() * 8)} ${x + 14} ${y - 4}`);
    x += 14;
    if (x > 270) break;
  }
  return parts.join(' ');
}

const SHAPES = { sig1: [17, 7], sig2: [233, 6], sig3: [541, 8], sig4: [389, 5], sig5: [97, 7] };

/** The SVG text of a demo signature, or null for an unknown name. */
export function signatureSvg(name) {
  const sh = SHAPES[name];
  if (!sh) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90" role="img" aria-label="Signature (demo drawing)"><path d="${scribble(sh[0], sh[1])}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 74 L${150 + sh[1] * 10} 70" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
export const DEMO_SIGNATURES = Object.keys(SHAPES);
