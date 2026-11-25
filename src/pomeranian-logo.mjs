import { readFileSync } from 'node:fs';
import { Image, backgroundAnsi, foregroundAnsi, getCapabilities, getTerminalColorMode, rgbColor } from '@earendil-works/pi-tui';

const sampleWidth = 56;
const sampleHeight = 52;
export const mascotFrames = ['idle', 'think', 'dribble', 'kick', 'celebrate', 'concern'];
const samples = new Map();
const thumbnails = new Map();
const png = new Map();

function asset(frame, format) {
  if (!mascotFrames.includes(frame)) throw new Error('Unknown mascot frame');
  return readFileSync(new URL(`../assets/mascot/${frame}.${format}`, import.meta.url));
}

function pixel(sample, x, y) {
  const index = (y * sampleWidth + x) * 3;
  return rgbColor(sample[index], sample[index + 1], sample[index + 2]);
}

export function renderMascotThumbnail(width, colorMode = getTerminalColorMode(), frame = 'idle', maxRows = sampleHeight / 2) {
  const columns = Math.max(1, Math.min(width, sampleWidth, Math.floor(maxRows * 2 * sampleWidth / sampleHeight)));
  const key = `${columns}/${colorMode}/${frame}`;
  if (thumbnails.has(key)) return thumbnails.get(key);
  if (!samples.has(frame)) samples.set(frame, asset(frame, 'rgb'));
  const sample = samples.get(frame);
  const height = Math.max(2, 2 * Math.round(columns * sampleHeight / sampleWidth / 2));
  const lines = [];
  for (let row = 0; row < height; row += 2) {
    let line = '';
    const y = Math.floor(row * sampleHeight / height);
    const nextY = Math.floor((row + 1) * sampleHeight / height);
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * sampleWidth / columns);
      line += foregroundAnsi(pixel(sample, x, y), colorMode) + backgroundAnsi(pixel(sample, x, nextY), colorMode) + '▀';
    }
    lines.push(line + '\x1b[0m');
  }
  thumbnails.set(key, lines);
  return lines;
}

export function createMascotImage(theme, height, frame = 'idle') {
  if (!getCapabilities().images) return undefined;
  if (!png.has(frame)) png.set(frame, asset(frame, 'png').toString('base64'));
  return new Image(png.get(frame), 'image/png', { fallbackColor: value => theme.fg('dim', value) }, {
    filename: `pomeranian-${frame}.png`, maxWidthCells: 56, maxHeightCells: height
  });
}
