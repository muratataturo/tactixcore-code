import { readFileSync } from 'node:fs';
import { Image, backgroundAnsi, foregroundAnsi, getCapabilities, getTerminalColorMode, rgbColor } from '@earendil-works/pi-tui';

const sampleWidth = 44;
const sampleHeight = 28;
const sample = readFileSync(new URL('../assets/pomeranian.rgb', import.meta.url));
let png;

function pixel(x, y) {
  const index = (y * sampleWidth + x) * 3;
  return rgbColor(sample[index], sample[index + 1], sample[index + 2]);
}

export function renderMascotThumbnail(width, colorMode = getTerminalColorMode()) {
  const columns = Math.min(width, sampleWidth);
  const height = Math.max(2, 2 * Math.round(sampleHeight * columns / sampleWidth / 2));
  const lines = [];
  for (let row = 0; row < height; row += 2) {
    let line = '';
    const y = Math.floor(row * sampleHeight / height);
    const nextY = Math.floor((row + 1) * sampleHeight / height);
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * sampleWidth / columns);
      line += foregroundAnsi(pixel(x, y), colorMode) + backgroundAnsi(pixel(x, nextY), colorMode) + '▀';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines;
}

export function createMascotImage(theme, height) {
  if (!getCapabilities().images) return undefined;
  png ??= readFileSync(new URL('../assets/pomeranian.png', import.meta.url)).toString('base64');
  return new Image(png, 'image/png', { fallbackColor: value => theme.fg('dim', value) }, {
    filename: 'pomeranian.png', maxWidthCells: 44, maxHeightCells: height
  });
}
