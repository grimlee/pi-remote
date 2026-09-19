import * as QRCode from "qrcode";

export interface CompactQr {
  text: string;
  moduleCount: number;
  widthCharacters: number;
  heightLines: number;
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export function renderCompactQr(
  value: string,
  marginModules = 4,
): CompactQr {
  if (!Number.isInteger(marginModules)
      || marginModules < 4
      || marginModules > 16) {
    throw new RangeError(
      "QR quiet-zone margin must be between 4 and 16 modules",
    );
  }

  const qr = QRCode.create(value, {
    errorCorrectionLevel: "L",
  });
  const size = qr.modules.size;
  const paddedSize = size + marginModules * 2;
  const widthCharacters = Math.ceil(paddedSize / 2);
  const heightLines = Math.ceil(paddedSize / 4);

  const isDark = (row: number, col: number): boolean => {
    const qrRow = row - marginModules;
    const qrCol = col - marginModules;
    if (qrRow < 0 || qrCol < 0 || qrRow >= size || qrCol >= size) {
      return false;
    }
    return qr.modules.get(qrRow, qrCol) !== 0;
  };

  const lines: string[] = [];
  for (let cellRow = 0; cellRow < heightLines; cellRow += 1) {
    let line = "";
    for (let cellCol = 0; cellCol < widthCharacters; cellCol += 1) {
      let pattern = 0;
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 2; col += 1) {
          const moduleRow = cellRow * 4 + row;
          const moduleCol = cellCol * 2 + col;
          if (moduleRow >= paddedSize || moduleCol >= paddedSize) {
            continue;
          }
          if (isDark(moduleRow, moduleCol)) {
            pattern |= BRAILLE_BITS[row]![col]!;
          }
        }
      }
      line += String.fromCodePoint(BRAILLE_BASE + pattern);
    }
    lines.push(line);
  }

  return {
    text: lines.join("\n"),
    moduleCount: size,
    widthCharacters,
    heightLines,
  };
}

export function colorizeCompactQr(text: string): string {
  return text
    .split("\n")
    .map(line => "\x1b[30;47m" + line + "\x1b[0m")
    .join("\n");
}
