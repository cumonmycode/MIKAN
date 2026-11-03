// @ts-check
/**
 * A small QR Code encoder (byte mode, versions 1–40, error correction L/M/Q/H, automatic or fixed mask) for the
 * payment link. It follows the structure of Project Nayuki's reference «QR Code generator library» (MIT License,
 * https://www.nayuki.io/page/qr-code-generator-library), reduced to what the page needs, and is checked in the
 * tests against known matrices.
 */

/** Error-correction codewords per block, by level (L, M, Q, H) and version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

/** Error-correction blocks, by level (L, M, Q, H) and version (index 0 unused). */
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Level → [table row, the two format bits]. */
const LEVELS = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const getBit = (value, index) => ((value >>> index) & 1) !== 0;

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, row) {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[row][version] * NUM_ERROR_CORRECTION_BLOCKS[row][version];
}

/** Bits of the byte-mode character count. */
const charCountBits = (version) => (version <= 9 ? 8 : 16);

/** GF(2^8) product modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/** Splits the data into blocks, appends each block's error correction and interleaves them. */
function addEccAndInterleave(data, version, row) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[row][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[row][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      // Skip the padding byte of the short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/** Data codewords for `bytes` in byte mode, padded to the capacity of `version`. */
function dataCodewords(bytes, version, row) {
  const capacityBits = numDataCodewords(version, row) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0x4, 4);
  push(bytes.length, charCountBits(version));
  bytes.forEach((byte) => push(byte, 8));
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => {
    codewords[i >>> 3] |= bit << (7 - (i & 7));
  });
  return codewords;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The module grid being drawn: `dark[y][x]`, plus which modules belong to function patterns. */
function createGrid(size) {
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFunction = (x, y, isDark) => {
    dark[y][x] = isDark;
    isFunction[y][x] = true;
  };
  return { size, dark, isFunction, setFunction };
}

function drawFormatBits(grid, formatLevel, mask) {
  const { size, setFunction } = grid;
  const data = (formatLevel << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, getBit(bits, i));
  setFunction(8, 7, getBit(bits, 6));
  setFunction(8, 8, getBit(bits, 7));
  setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, getBit(bits, i));
  setFunction(8, size - 8, true);
}

function drawVersion(grid, version) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const color = getBit(bits, i);
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.setFunction(a, b, color);
    grid.setFunction(b, a, color);
  }
}

function drawFunctionPatterns(grid, version, formatLevel) {
  const { size, setFunction } = grid;
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = alignmentPositions(version, size);
  const n = positions.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormatBits(grid, formatLevel, 0);
  drawVersion(grid, version);
}

function drawCodewords(grid, codewords) {
  const { size, dark, isFunction } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          dark[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** XORs the data modules with the mask (applying it twice undoes it). */
function applyMask(grid, mask) {
  const { size, dark, isFunction } = grid;
  const invert = MASKS[mask];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && invert(x, y)) dark[y][x] = !dark[y][x];
    }
  }
}

function finderPenaltyCountPatterns(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function finderPenaltyAddHistory(runLength, history, size) {
  const length = history[0] === 0 ? runLength + size : runLength; // light border before the first run
  history.pop();
  history.unshift(length);
}

function finderPenaltyTerminateAndCount(runColor, runLength, history, size) {
  let length = runLength;
  if (runColor) {
    finderPenaltyAddHistory(length, history, size);
    length = 0;
  }
  finderPenaltyAddHistory(length + size, history, size); // light border after the last run
  return finderPenaltyCountPatterns(history);
}

/** Penalty of one line (row or column) read through `get(i)`: long runs and finder-like patterns. */
function linePenalty(size, get) {
  let result = 0;
  let runColor = false;
  let runLength = 0;
  const history = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < size; i += 1) {
    if (get(i) === runColor) {
      runLength += 1;
      if (runLength === 5) result += PENALTY_N1;
      else if (runLength > 5) result += 1;
    } else {
      finderPenaltyAddHistory(runLength, history, size);
      if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
      runColor = get(i);
      runLength = 1;
    }
  }
  return result + finderPenaltyTerminateAndCount(runColor, runLength, history, size) * PENALTY_N3;
}

function penaltyScore(grid) {
  const { size, dark } = grid;
  let result = 0;
  for (let y = 0; y < size; y += 1) result += linePenalty(size, (x) => dark[y][x]);
  for (let x = 0; x < size; x += 1) result += linePenalty(size, (y) => dark[y][x]);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = dark[y][x];
      if (color === dark[y][x + 1] && color === dark[y + 1][x] && color === dark[y + 1][x + 1]) result += PENALTY_N2;
    }
  }
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  return result + k * PENALTY_N4;
}

/**
 * Encodes `text` (UTF-8, byte mode) at the smallest version that fits.
 * @param {string} text
 * @param {{ level?: 'L' | 'M' | 'Q' | 'H', mask?: number }} [options] `mask` −1 (default) picks the best one.
 * @returns {{ version: number, size: number, mask: number, level: string, modules: boolean[][] }}
 */
export function encodeQr(text, { level = 'M', mask = -1 } = {}) {
  const levelInfo = LEVELS[level];
  if (!levelInfo) throw new RangeError(`Unknown error correction level: ${level}`);
  if (!Number.isInteger(mask) || mask < -1 || mask > 7) throw new RangeError(`Bad mask: ${mask}`);
  const [row, formatLevel] = levelInfo;
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 1;
  for (;;) {
    const usedBits = 4 + charCountBits(version) + bytes.length * 8;
    if (bytes.length < 2 ** charCountBits(version) && usedBits <= numDataCodewords(version, row) * 8) break;
    if (version >= 40) throw new RangeError('Слишком длинная ссылка для QR-кода');
    version += 1;
  }
  const size = version * 4 + 17;
  const grid = createGrid(size);
  drawFunctionPatterns(grid, version, formatLevel);
  drawCodewords(grid, addEccAndInterleave(dataCodewords(bytes, version, row), version, row));
  let chosen = mask;
  if (chosen === -1) {
    let minPenalty = Infinity;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      applyMask(grid, candidate);
      drawFormatBits(grid, formatLevel, candidate);
      const penalty = penaltyScore(grid);
      if (penalty < minPenalty) {
        chosen = candidate;
        minPenalty = penalty;
      }
      applyMask(grid, candidate);
    }
  }
  applyMask(grid, chosen);
  drawFormatBits(grid, formatLevel, chosen);
  return { version, size, mask: chosen, level, modules: grid.dark };
}

/** SVG path data of the dark modules, shifted by a quiet zone of `border` modules. */
export function qrPath(qr, border = 4) {
  const parts = [];
  qr.modules.forEach((row, y) => {
    row.forEach((isDark, x) => {
      if (isDark) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    });
  });
  return parts.join('');
}

/** The QR code as a standalone SVG string (black on white, whatever the page theme). */
export function qrSvg(qr, { border = 4, title = 'QR-код' } = {}) {
  const dim = qr.size + border * 2;
  const safeTitle = String(title).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${safeTitle}">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
    `<path d="${qrPath(qr, border)}" fill="#000"/></svg>`
  );
}
