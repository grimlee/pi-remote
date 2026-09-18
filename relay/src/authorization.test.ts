import assert from "node:assert/strict";
import test from "node:test";
import {
  machineGrantMessage,
  verifyMachineGrant,
  type MachineGrant,
} from "./authorization.js";

test("machine grant canonical bytes and signature match Swift vector", () => {
  const grant: MachineGrant = {
    version: 1,
    grantId: "grant_testvector",
    machine: {
      id: "machine_testvector",
      signingPublicKey: "ZuPCgpL12lNpVI89bigCIxa3d7xoXY1g6l5PU_p5N7Y",
      keyAgreementPublicKey: "9fR7Li99huaimb2kfn_CarEsBG-jQAfjRZLsoDoSY0Q",
    },
    device: {
      id: "device_testvector",
      signingPublicKey: "yM6EbQV4R3kp5yy_dnkBqsme8jA9ypGFMbhwAvc6hZc",
      keyAgreementPublicKey: "OHWQojocMsWFkAFfLZ0XtemKwhoYP_h0kv3KIN8FM34",
    },
    role: "owner",
    issuedAt: "2026-09-18T00:00:00.000Z",
    signature:
      "rcoeWH6bdn0dwmFd0aFp-QM95p1BVMdP5n24mQGhu99yuXibsR-NCKjANa1qY_-Se0tqzrgXkpcYMIhlrBbVCA",
  };

  const { signature: _signature, ...unsigned } = grant;
  assert.equal(
    machineGrantMessage(unsigned).toString("base64url"),
    "cGlyZW1vdGUtbWFjaGluZS1ncmFudC12MQBncmFudF90ZXN0dmVjdG9yAG1hY2hpbmVfdGVzdHZlY3RvcgBadVBDZ3BMMTJsTnBWSTg5YmlnQ0l4YTNkN3hvWFkxZzZsNVBVX3A1TjdZADlmUjdMaTk5aHVhaW1iMmtmbl9DYXJFc0JHLWpRQWZqUlpMc29Eb1NZMFEAZGV2aWNlX3Rlc3R2ZWN0b3IAeU02RWJRVjRSM2twNXl5X2Rua0Jxc21lOGpBOXlwR0ZNYmh3QXZjNmhaYwBPSFdRb2pvY01zV0ZrQUZmTFowWHRlbUt3aG9ZUF9oMGt2M0tJTjhGTTM0AG93bmVyADIwMjYtMDktMThUMDA6MDA6MDAuMDAwWg",
  );
  assert.equal(verifyMachineGrant(grant), true);
});
