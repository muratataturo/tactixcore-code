// Terminal-size kick pose for Luke, using the existing mascot's cream and mint palette.
const palette = {
  p: '16;39;37', g: '38;83;66', a: '112;189;155',
  d: '58;59;62', o: '176;165;150', s: '226;214;197', w: '255;249;235', h: '255;255;255',
  e: '48;40;37', r: '239;179;172', m: '117;188;166', y: '255;199;103',
  b: '231;238;233', k: '89;105;109'
};

const pixels = Array.from({ length: 18 }, () => Array(38).fill('p'));
const paint = (y, x, colors) => pixels[y].splice(x, colors.length, ...colors);

// Curled tail and a continuous white body, with a forepaw extended toward the ball.
[
  [3, 4, 'oswo'],
  [4, 2, 'oswwwo'],
  [5, 2, 'owhswso'],
  [6, 2, 'oshwwsso'],
  [7, 3, 'oswwwwso'],
  [8, 5, 'oswwhwss'],
  [9, 6, 'oshwwwhwwsso'],
  [10, 6, 'swhhwwwwhwwwwso'],
  [11, 6, 'swwwwhwwwhwwwwsso'],
  [12, 7, 'owwshwwwwwwswwwsso'],
  [13, 8, 'swwwwssssssoswwwwwwso'],
  [14, 8, 'oswwsooooooooswwsso'],
  [15, 8, 'oswwo'],
  [15, 16, 'oswwo'],
  [16, 8, 'oswso'],
  [16, 16, 'oswso']
].forEach(([y, x, colors]) => paint(y, x, colors));

// Pointed ears, a fluffy ruff, dark eye and nose, and Luke's mint collar.
[
  [0, 14, 'os'],
  [1, 13, 'owso'],
  [1, 19, 'os'],
  [2, 13, 'owrso'],
  [2, 18, 'oswso'],
  [3, 12, 'oswrswhhwwso'],
  [4, 11, 'oswhhhhhhhwwso'],
  [5, 10, 'oswwhhhhhhhhhwsso'],
  [6, 10, 'swhhhhhhhehwhwwsso'],
  [7, 9, 'oswhhhhhheewhwwwee'],
  [8, 9, 'oswwhhhhhwwrwwsweo'],
  [9, 10, 'oswwhhhhhwrwweeoo'],
  [10, 11, 'oswwwwwwhwwwso'],
  [11, 12, 'oswhwwwwwwsso'],
  [12, 13, 'osmmmmmmmmo'],
  [13, 15, 'osmyyms']
].forEach(([y, x, colors]) => paint(y, x, colors));

// Black-and-white panels and short motion marks make the kick readable at terminal size.
[
  [9, 32, 'y'],
  [10, 34, 'a'],
  [11, 30, 'kbbk'],
  [12, 26, 'a'],
  [12, 29, 'kbwhbk'],
  [13, 29, 'kwhdkk'],
  [14, 29, 'kbdhbk'],
  [15, 30, 'kkbk'],
  [15, 35, 'a'],
  [16, 29, 'gggggg'],
  [17, 2, 'gggggggggggggggggggggggggggggggggg']
].forEach(([y, x, colors]) => paint(y, x, colors));

function block(top, bottom) {
  return `\x1b[38;2;${palette[top] ?? palette.b};48;2;${palette[bottom] ?? palette.b}m▀`;
}

export function pomeranianLogo() {
  return pixels.filter((_, index) => index % 2 === 0).map((row, index) =>
    row.map((color, column) => block(color, pixels[index * 2 + 1][column])).join('') + '\x1b[0m'
  );
}
