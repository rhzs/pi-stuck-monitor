import assert from "node:assert/strict";
import test from "node:test";

import {
  isSteerUpCooldownActive,
  resolveSteerUpAfterTurn,
} from "../index.ts";

test("clears pending steer-up when the task completes", () => {
  const pending = {
    reason: "too many tools",
    message: "Step back and focus.",
    turnIndex: 3,
  };

  const decision = resolveSteerUpAfterTurn(pending, false);

  assert.equal(decision.messageToSend, null);
  assert.equal(decision.nextPending, null);
});

test("delivers pending steer-up when the agent is continuing", () => {
  const pending = {
    reason: "too many tools",
    message: "Step back and focus.",
    turnIndex: 3,
  };

  const decision = resolveSteerUpAfterTurn(pending, true);

  assert.equal(decision.messageToSend, pending.message);
  assert.equal(decision.nextPending, null);
});

test("does not deliver pending steer-up during cooldown", () => {
  const pending = {
    reason: "too many tools",
    message: "Step back and focus.",
    turnIndex: 3,
  };

  const decision = resolveSteerUpAfterTurn(pending, true, {
    cooldownMs: 5 * 60 * 1000,
    lastSteerUpAt: 1_000,
    now: 2_000,
  });

  assert.equal(decision.messageToSend, null);
  assert.equal(decision.nextPending, null);
});

test("reports active steer-up cooldown until configured duration elapses", () => {
  assert.equal(
    isSteerUpCooldownActive({
      cooldownMs: 5 * 60 * 1000,
      lastSteerUpAt: 1_000,
      now: 2_000,
    }),
    true,
  );
  assert.equal(
    isSteerUpCooldownActive({
      cooldownMs: 5 * 60 * 1000,
      lastSteerUpAt: 1_000,
      now: 301_000,
    }),
    false,
  );
});
