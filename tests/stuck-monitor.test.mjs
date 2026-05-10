import assert from "node:assert/strict";
import test from "node:test";

import {
  isSteerUpCooldownActive,
  resetStateOnTaskComplete,
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

test("resets detection state when the task completes so the next task starts clean", () => {
  const priorHistory = [
    { turnIndex: 0, toolCount: 1, mutations: 0, errors: 0, readPaths: ["a.ts"], duration: 10 },
    { turnIndex: 1, toolCount: 1, mutations: 0, errors: 1, readPaths: ["a.ts"], duration: 10 },
  ];

  const result = resetStateOnTaskComplete({
    history: priorHistory,
    nudgesSent: 4,
    pendingSteerUp: {
      reason: "too many tools",
      message: "Step back.",
      turnIndex: 1,
    },
  });

  assert.deepEqual(result.state.history, []);
  assert.equal(result.state.nudgesSent, 0);
  assert.equal(result.state.pendingSteerUp, null);
  assert.equal(result.hadPendingSteerUp, true);
});

test("reset on task complete reports no pending steer-up when none was armed", () => {
  const result = resetStateOnTaskComplete({
    history: [],
    nudgesSent: 0,
    pendingSteerUp: null,
  });

  assert.equal(result.hadPendingSteerUp, false);
  assert.deepEqual(result.state.history, []);
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
