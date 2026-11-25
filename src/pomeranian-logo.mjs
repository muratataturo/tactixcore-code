import { readFileSync } from 'node:fs';
import { Image, backgroundAnsi, foregroundAnsi, getCapabilities, getTerminalColorMode, rgbColor } from '@earendil-works/pi-tui';

const sampleSize = 34;
const frames = ['idle', 'think', 'dribble', 'kick', 'celebrate', 'concern'];
const samples = new Map();
const thumbnails = new Map();
const png = new Map();

function asset(frame, format) {
  if (!frames.includes(frame)) throw new Error('Unknown mascot frame');
  return readFileSync(new URL(`../assets/mascot/${frame}.${format}`, import.meta.url));
}

function pixel(sample, x, y) {
  const index = (y * sampleSize + x) * 3;
  return rgbColor(sample[index], sample[index + 1], sample[index + 2]);
}

export function renderMascotThumbnail(width, colorMode = getTerminalColorMode(), frame = 'idle') {
  const columns = Math.min(width, sampleSize);
  const key = `${columns}/${colorMode}/${frame}`;
  if (thumbnails.has(key)) return thumbnails.get(key);
  if (!samples.has(frame)) samples.set(frame, asset(frame, 'rgb'));
  const sample = samples.get(frame);
  const height = Math.max(2, 2 * Math.round(columns / 2));
  const lines = [];
  for (let row = 0; row < height; row += 2) {
    let line = '';
    const y = Math.floor(row * sampleSize / height);
    const nextY = Math.floor((row + 1) * sampleSize / height);
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(column * sampleSize / columns);
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
    filename: `pomeranian-${frame}.png`, maxWidthCells: 36, maxHeightCells: height
  });
}
