import * as QRCode from "qrcode";

export interface SixelQr {
  text: string;
  widthPixels: number;
  heightPixels: number;
  moduleCount: number;
}

function sixelRun(patterns: number[]): string {
  if (patterns.length === 0) return "";

  let output = "";
  let current = patterns[0]!;
  let count = 1;

  const flush = (): void => {
    const char = String.fromCharCode(63 + current);
    if (count >= 4) {
      output += `!${count}${char}`;
    } else {
      output += char.repeat(count);
    }
  };

  for (let index = 1; index < patterns.length; index += 1) {
    const value = patterns[index]!;
    if (value === current) {
      count += 1;
      continue;
    }
    flush();
    current = value;
    count = 1;
  }
  flush();
  return output;
}

export function renderSixelQr(
  value: string,
  moduleScale = 2,
  marginModules = 4,
): SixelQr {
  if (!Number.isInteger(moduleScale)
      || moduleScale < 1
      || moduleScale > 6) {
    throw new RangeError(
      "QR module scale must be between 1 and 6 pixels",
    );
  }
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
  const fullModules = size + marginModules * 2;
  const width = fullModules * moduleScale;
  const height = fullModules * moduleScale;

  const isDarkPixel = (x: number, y: number): boolean => {
    const moduleCol = Math.floor(x / moduleScale) - marginModules;
    const moduleRow = Math.floor(y / moduleScale) - marginModules;
    if (moduleRow < 0
        || moduleCol < 0
        || moduleRow >= size
        || moduleCol >= size) {
      return false;
    }
    return qr.modules.get(moduleRow, moduleCol) !== 0;
  };

  let output = "\x1bPq";
  output += `"1;1;${width};${height}`;

  // Register 0 as black and 1 as white.
  output += "#0;2;0;0;0#1;2;100;100;100";

  for (let y = 0; y < height; y += 6) {
    // Paint an opaque white background for this sixel band.
    output += "#1";
    output += `!${width}~`;
    output += "$";

    // Paint black QR pixels over the white background.
    output += "#0";
    const patterns: number[] = [];
    for (let x = 0; x < width; x += 1) {
      let pattern = 0;
      for (let bit = 0; bit < 6; bit += 1) {
        const py = y + bit;
        if (py < height && isDarkPixel(x, py)) {
          pattern |= 1 << bit;
        }
      }
      patterns.push(pattern);
    }
    output += sixelRun(patterns);

    if (y + 6 < height) output += "-";
  }

  output += "\x1b\\";

  return {
    text: output,
    widthPixels: width,
    heightPixels: height,
    moduleCount: size,
  };
}
