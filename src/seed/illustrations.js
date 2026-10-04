// Demo "photos": small SVG drawings of Montessori materials. Never people. The public demo has no real photos, so
// every demo photo row carries demo:{illustration:'<name>'} and the app draws one of these at runtime.
// Colours are the Kinfolk palette (docs/DESIGN-SYSTEM.md). Every number below is at most three digits, so the
// scan's Aadhaar / mobile-number rules can never match path data.

const C = { ivory: '#FDF8EE', linen: '#F7F1E3', sand: '#EAE3D2', forest: '#355C2E', leaf: '#7C9B60', sun: '#FDD550', marigold: '#B8860B', lake: '#2F6585', brick: '#A8442C', bark: '#86592B', peach: '#E49D77', ink: '#1E3446' };

const frame = (label, inner, size = '200 150') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size}" role="img" aria-label="${label}"><rect width="100%" height="100%" fill="${C.linen}"/>${inner}</svg>`;
const seq = n => Array.from({ length: n }, (_, i) => i);

const pinkTower = () => {
  let y = 142;
  const cubes = seq(10).map(i => { const s = 22 - i * 2; y -= s; return `<rect x="${100 - s / 2}" y="${y}" width="${s}" height="${s}" fill="${C.peach}" stroke="${C.bark}" stroke-width="1"/>`; }).join('');
  return frame('A tower of ten pink cubes, largest at the bottom', `<rect x="40" y="142" width="120" height="6" fill="${C.sand}"/>${cubes}`);
};

const brownStair = () => frame('Ten brown prisms in a graded staircase',
  `<rect x="10" y="132" width="180" height="6" fill="${C.sand}"/>` +
  seq(10).map(i => `<rect x="${14 + i * 17}" y="${130 - (i + 1) * 10}" width="15" height="${(i + 1) * 10}" fill="${C.bark}" stroke="${C.ink}" stroke-width="1"/>`).join(''));

const redRods = () => frame('Ten red rods graded in length',
  seq(10).map(i => `<rect x="12" y="${14 + i * 13}" width="${16 + i * 16}" height="9" fill="${C.brick}" stroke="${C.ink}" stroke-width="1"/>`).join(''));

const knobbedCylinders = () => frame('A wooden block with ten knobbed cylinders of growing size',
  `<rect x="8" y="46" width="184" height="58" rx="6" fill="${C.sun}" stroke="${C.marigold}" stroke-width="2"/>` +
  seq(10).map(i => `<circle cx="${22 + i * 17}" cy="75" r="${3 + Math.floor(i * 0.7)}" fill="${C.bark}"/><circle cx="${22 + i * 17}" cy="75" r="1" fill="${C.sun}"/>`).join(''));

const colourTablets = () => {
  const cols = [C.brick, C.lake, C.sun, C.forest, C.peach, C.bark];
  return frame('Six pairs of colour tablets',
    cols.map((c, i) => {
      const x = 14 + (i % 3) * 62, y = 18 + Math.floor(i / 3) * 66;
      return `<rect x="${x}" y="${y}" width="24" height="44" rx="2" fill="${c}" stroke="${C.ink}" stroke-width="1"/><rect x="${x + 28}" y="${y}" width="24" height="44" rx="2" fill="${c}" stroke="${C.ink}" stroke-width="1"/>`;
    }).join(''));
};

const pouringJugs = () => {
  const jug = (x, fill) => `<path d="M${x} 50 h40 v60 a6 6 0 0 1 -6 6 h-28 a6 6 0 0 1 -6 -6 z" fill="${C.ivory}" stroke="${C.ink}" stroke-width="2"/>` +
    `<rect x="${x + 2}" y="${116 - fill}" width="36" height="${fill}" fill="${C.lake}" opacity="0.7"/>` +
    `<path d="M${x + 40} 62 q16 0 16 16 t-16 16" fill="none" stroke="${C.ink}" stroke-width="3"/>`;
  return frame('Two jugs on a tray, one holding more water than the other',
    `<rect x="14" y="108" width="172" height="26" rx="6" fill="${C.sand}" stroke="${C.marigold}" stroke-width="2"/>${jug(24, 44)}${jug(110, 20)}`);
};

const movableAlphabet = () => {
  const tile = (x, ch, fill) => `<rect x="${x}" y="40" width="40" height="52" rx="5" fill="${fill}" stroke="${C.ink}" stroke-width="2"/><text x="${x + 20}" y="76" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#fff">${ch}</text>`;
  return frame('Three wooden letter tiles spelling c, a, t', `<rect x="14" y="100" width="172" height="24" rx="5" fill="${C.sand}"/>${tile(24, 'c', C.lake)}${tile(80, 'a', C.brick)}${tile(136, 't', C.lake)}`);
};

const numberRods = () => frame('Number rods one to ten, in alternating red and blue sections',
  seq(10).map(i => seq(i + 1).map(j => `<rect x="${12 + j * 15}" y="${12 + i * 13}" width="15" height="10" fill="${j % 2 ? C.lake : C.brick}"/>`).join('')).join(''));

const goldenBeads = () => {
  const defs = `<defs><pattern id="b" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="3" fill="${C.sun}" stroke="${C.marigold}" stroke-width="1"/></pattern></defs>`;
  return frame('Golden bead material: a hundred square, a ten bar and a single unit',
    `${defs}<rect x="14" y="20" width="80" height="80" fill="url(#b)"/><rect x="120" y="20" width="8" height="80" fill="url(#b)"/><rect x="156" y="20" width="8" height="8" fill="url(#b)"/>`);
};

const continentPuzzle = () => frame('A puzzle map with seven coloured land pieces',
  [[C.forest, '20,30 60,20 80,50 50,80 24,64'], [C.brick, '90,24 130,18 140,52 104,60'], [C.sun, '150,30 186,40 176,76 148,62'],
    [C.peach, '30,92 70,88 80,120 44,132'], [C.lake, '96,86 132,84 128,124 100,126'], [C.leaf, '144,92 184,96 170,130 146,122'], [C.bark, '86,64 100,68 96,82 84,78']]
    .map(([f, pts]) => `<polygon points="${pts}" fill="${f}" stroke="${C.ink}" stroke-width="1"/>`).join(''));

const BUILDERS = { pinkTower, brownStair, redRods, knobbedCylinders, colourTablets, pouringJugs, movableAlphabet, numberRods, goldenBeads, continentPuzzle };

export const ILLUSTRATION_NAMES = Object.keys(BUILDERS);
/** Which drawing suits each classroom area, in the order the seed uses them. */
export const ILLUSTRATIONS_BY_AREA = {
  practicalLife: ['pouringJugs'],
  sensorial: ['pinkTower', 'brownStair', 'redRods', 'knobbedCylinders', 'colourTablets'],
  language: ['movableAlphabet'],
  math: ['numberRods', 'goldenBeads'],
  culture: ['continentPuzzle'],
};

/** The SVG text for a named illustration, or null for an unknown name. */
export const illustrationSvg = name => (BUILDERS[name] ? BUILDERS[name]() : null);
/** The drawing's own description, for alt text. */
export function illustrationAlt(name) {
  const svg = illustrationSvg(name);
  const m = svg && /aria-label="([^"]*)"/.exec(svg);
  return m ? m[1] : 'Illustration of a classroom material';
}
