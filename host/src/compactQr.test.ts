import assert from "node:assert/strict";
import test from "node:test";
import { colorizeCompactQr, renderCompactQr } from "./compactQr.js";

test("compact QR packs modules into a much smaller terminal footprint", () => {
  const qr = renderCompactQr("piremote-pair-v1z.test-payload");
  assert.ok(qr.moduleCount >= 21);
  assert.equal(
    qr.widthCharacters,
    Math.ceil((qr.moduleCount + 8) / 2),
  );
  assert.equal(
    qr.heightLines,
    Math.ceil((qr.moduleCount + 8) / 4),
  );
  assert.equal(qr.text.split("\n").length, qr.heightLines);
  assert.ok(qr.widthCharacters < qr.moduleCount + 8);
  assert.ok(qr.heightLines < Math.ceil((qr.moduleCount + 8) / 2));
});

test("compact QR preserves a four-module quiet zone", () => {
  const qr = renderCompactQr("hello");
  const lines = qr.text.split("\n");
  assert.ok(lines.length > 0);

  // Four quiet modules map to two Braille columns and one Braille row.
  assert.equal(lines[0], "\u2800".repeat(qr.widthCharacters));
  for (const line of lines) {
    assert.ok(line.startsWith("\u2800\u2800"));
    assert.ok(line.endsWith("\u2800\u2800"));
  }
});

test("compact QR colorizer forces standard black-on-white contrast", () => {
  const styled = colorizeCompactQr("abc\ndef");
  assert.equal(
    styled,
    "\x1b[30;47mabc\x1b[0m\n\x1b[30;47mdef\x1b[0m",
  );
});
