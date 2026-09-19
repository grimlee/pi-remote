import assert from "node:assert/strict";
import test from "node:test";
import { renderSixelQr } from "./sixelQr.js";

test("sixel QR keeps square pixel geometry with a four-module quiet zone", () => {
  const qr = renderSixelQr(
    "piremote-pair-v1z.test-payload",
    2,
    4,
  );

  assert.ok(qr.moduleCount >= 21);
  assert.equal(
    qr.widthPixels,
    (qr.moduleCount + 8) * 2,
  );
  assert.equal(qr.heightPixels, qr.widthPixels);
  assert.ok(qr.text.startsWith("\x1bPq"));
  assert.ok(qr.text.endsWith("\x1b\\"));
  assert.ok(qr.text.includes(
    `"1;1;${qr.widthPixels};${qr.heightPixels}`,
  ));
});

test("sixel QR scale bounds are enforced", () => {
  assert.throws(
    () => renderSixelQr("hello", 0),
    /module scale/,
  );
  assert.throws(
    () => renderSixelQr("hello", 7),
    /module scale/,
  );
});
