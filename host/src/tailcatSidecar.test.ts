import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTailcatAddress,
  redactTailcatSecrets,
  tailcatServeArgs,
} from "./tailcatSidecar.js";

test("extractTailcatAddress reads Tailcat CLI startup output", () => {
  const address = "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu";
  assert.equal(
    extractTailcatAddress(
      `# Selected bootstrap relay region 302\n# 🐈 Server listening with new address: ${address}\n`,
    ),
    address,
  );
  assert.equal(extractTailcatAddress("no address yet"), null);
});

test("tailcatServeArgs exposes only the loopback relay port", () => {
  assert.deepEqual(
    tailcatServeArgs({ relayPort: 8780 }),
    ["serve", "--full-address", "8780"],
  );
  assert.deepEqual(
    tailcatServeArgs({ relayPort: 8780, key: "piremote" }),
    ["serve", "--full-address", "--key=piremote", "8780"],
  );
  assert.deepEqual(
    tailcatServeArgs({
      relayPort: 8780,
      key: "piremote",
      verbose: true,
    }),
    ["--verbose", "serve", "--full-address", "--key=piremote", "8780"],
  );
  assert.throws(
    () => tailcatServeArgs({ relayPort: 0 }),
    /valid TCP port/,
  );
});


test("redactTailcatSecrets hides bearer capabilities in trace logs", () => {
  const secret = "tcomFwWCCcjS5nKNqAod034nWoJZW0LZqDhhC8U_dKdnDRYQ8uNGFpGQEu";
  assert.equal(
    redactTailcatSecrets(`server listening at ${secret}`),
    "server listening at tc[REDACTED]",
  );
});
