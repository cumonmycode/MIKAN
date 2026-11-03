import { describe, expect, it } from 'vitest';
import { encodeQr, qrPath, qrSvg } from '../public/book/lib/qr.js';

// Reference matrices produced by an independent encoder (node-qrcode 1.5.4, byte mode, level M, same mask);
// `#` — dark module. The encoder under test also picks these masks by itself.
const MIKAN_V1_M_MASK0 = [
  '#######..##...#######',
  '#.....#.##.#..#.....#',
  '#.###.#..#.#..#.###.#',
  '#.###.#..#.##.#.###.#',
  '#.###.#.#.###.#.###.#',
  '#.....#....#..#.....#',
  '#######.#.#.#.#######',
  '.........##..........',
  '#.#.#.#..##.#...#..#.',
  '..###..#..##.....###.',
  '..######...#..#######',
  '...#.#.##.###...#....',
  '.#...##....#.##.#.##.',
  '........#..#.....###.',
  '#######..##.######.##',
  '#.....#.....#..#...#.',
  '#.###.#.#.##..#.#.##.',
  '#.###.#..###...###.#.',
  '#.###.#.##.##.#.###.#',
  '#.....#..##....##..#.',
  '#######.#.....##..###',
];

const SBP_LINK = 'https://qr.nspk.ru/AS1000670LSS7DN18SJQDNP4B05KLJL2?type=02&bank=100000000284&sum=200000&cur=RUB&crc=C08B';
const SBP_V6_M_MASK2 = [
  '#######..###.#######.####.#...###.#######',
  '#.....#..######.#.#.....##.#.#..#.#.....#',
  '#.###.#.#.##..#...#.##..#..#..#...#.###.#',
  '#.###.#.##.#.#..#...#.#...##.#..#.#.###.#',
  '#.###.#.###..#.#..##...##.###.##..#.###.#',
  '#.....#.###.#..#..#...#.#..#..#.#.#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#######',
  '........###..##...#.###.#..##............',
  '#.#####....##.#########.######..#.#####..',
  '.#.#.#.#..#.#.#.#..#.#.###..##.##.#.#.#.#',
  '.#.#..###.#.##...##..##..####.#.##..#..#.',
  '.###.....#..##.##.#..##.......####..##...',
  '#.#.####.#..##..###.###...###..#.#.#.##.#',
  '##..#...#.#####.#..#.#.#..####.#..#.#...#',
  '.###..#.#.#.#.##.#...#.....###...#.#.....',
  '##.#.#...#.###.##.#..#.##..##.#...#.##...',
  '#.###.##.####.#.##..#....#..##...#.#...##',
  '#..###..#..........#.####.#...###.###...#',
  '###..##..###.#.#.##.....#.#####.....#..#.',
  '.#..#...##.#.#..#.#..##.#.##...#..#.##..#',
  '.######.#.....#.#.##......##.#..#..#..#..',
  '.##.#...#......##.#.######.##..#.#..#####',
  '##...######..####.#..#..##.####..#..##...',
  '#.#....####..#.#..##.####.##..#####.#....',
  '##.#.###..##.#.########..#.#####.#.#.####',
  '.#####..#....#.#.#.#..##....#.##.##.##.##',
  '.##.#.#.###.#..###..#...#..#.##.##.##....',
  '.#..#..##....#.......####...#..###.#.#...',
  '.#.#..#####...#..#..###.##..#..###.####..',
  '#.#.#..........#...#.#.#..#..###..#####.#',
  '#.#..#####..###.###.##..#..#.##..###.....',
  '#.#....#......##...#.#.#.........##.##.#.',
  '#....##..##...#..#..#....#.####.######...',
  '........#.###.####.#..###.#.....#...##..#',
  '#######...##...###...##.##.##..##.#.##.#.',
  '#.....#.#.#.####.###.##.#..##..##...#..##',
  '#.###.#.##..##..#....##.##..##..#######..',
  '#.###.#.##.#..##.##.##...#.###..##.#...##',
  '#.###.#.#..#.##.#.#.....####.#.#.####.#..',
  '#.....#....##.##.##.###.......#.....#..#.',
  '#######.###.####.####....##..#.#.#.####..',
];

const picture = (modules: boolean[][]) => modules.map((row) => row.map((dark) => (dark ? '#' : '.')).join(''));

describe('booking page: QR code generator', () => {
  it('matches the reference matrix for a short text', () => {
    const qr = encodeQr('MIKAN STUDIO', { level: 'M' });
    expect(qr).toMatchObject({ version: 1, size: 21, mask: 0, level: 'M' });
    expect(picture(qr.modules)).toEqual(MIKAN_V1_M_MASK0);
  });

  it('matches the reference matrix for an SBP payment link, picking the same mask by itself', () => {
    const auto = encodeQr(SBP_LINK, { level: 'M' });
    expect(auto).toMatchObject({ version: 6, size: 41, mask: 2 });
    expect(picture(auto.modules)).toEqual(SBP_V6_M_MASK2);
    expect(picture(encodeQr(SBP_LINK, { level: 'M', mask: 2 }).modules)).toEqual(SBP_V6_M_MASK2);
  });

  it('draws the version information from version 7 on', () => {
    const qr = encodeQr('x'.repeat(110), { level: 'M' });
    expect(qr.version).toBe(7);
    // Bit i of the 18-bit version block sits at row floor(i / 3), column size − 11 + i % 3.
    let bits = 0;
    for (let i = 0; i < 18; i += 1) {
      if (qr.modules[Math.floor(i / 3)]?.[qr.size - 11 + (i % 3)]) bits |= 1 << i;
    }
    expect(bits).toBe(0x07c94); // version 7 with its BCH(18,6) code
  });

  it('grows the version with the data and the error correction level', () => {
    expect(encodeQr('a'.repeat(14), { level: 'M' }).version).toBe(1);
    expect(encodeQr('a'.repeat(15), { level: 'M' }).version).toBe(2);
    expect(encodeQr('a'.repeat(17), { level: 'L' }).version).toBe(1);
    expect(encodeQr('При', { level: 'H' }).version).toBe(1); // 6 UTF-8 bytes fit 1-H (7)
    expect(encodeQr('Привет', { level: 'H' }).version).toBe(2); // 12 bytes do not
    expect(encodeQr('a'.repeat(2331), { level: 'M' }).version).toBe(40);
  });

  it('refuses data that does not fit and bad options', () => {
    expect(() => encodeQr('a'.repeat(2332), { level: 'M' })).toThrow(RangeError);
    expect(() => encodeQr('a', { level: 'X' as 'M' })).toThrow(RangeError);
    expect(() => encodeQr('a', { mask: 8 })).toThrow(RangeError);
  });

  it('renders a black-on-white SVG with a quiet zone', () => {
    const qr = encodeQr('MIKAN STUDIO', { level: 'M' });
    const darkCount = qr.modules.flat().filter(Boolean).length;
    expect(qrPath(qr).match(/M/g)).toHaveLength(darkCount);
    expect(qrPath(qr, 4).startsWith('M4,4h1v1h-1z')).toBe(true); // the top-left finder corner
    const svg = qrSvg(qr, { title: 'QR "оплата" <СБП>' });
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>');
    expect(svg).toContain('aria-label="QR &quot;оплата&quot; &lt;СБП&gt;"');
  });
});
