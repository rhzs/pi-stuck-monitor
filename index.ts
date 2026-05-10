// ~/.pi/agent/extensions/stuck-monitor.ts
// Detects when pi (the agent) gets stuck in repetitive thinking loops and auto-nudges it.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result?: {
    isError: boolean;
    truncated: boolean;
  };
}

interface TurnState {
  turnIndex: number;
  toolCalls: ToolCallRecord[];
  startTime: number;
}

interface TurnSummary {
  turnIndex: number;
  toolCount: number;
  mutations: number;   // edit + write
  errors: number;
  readPaths: string[];
  duration: number;
}

interface StuckConfig {
  maxReadRepeats: number;      // Same file read N times across turns without edit
  maxErrorRepeats: number;     // Consecutive turns with any error
  maxNoMutationTurns: number;  // Turns without file changes
  maxToolsPerTurn: number;     // Tool calls in a single turn (circular thinking)
  steerUpCooldownMs: number;   // Minimum time between automatic steer-ups
  nudgeMessage: string;
  autoNudge: boolean;
  autoCompact: boolean;
  debug: boolean;
}

interface PendingSteerUp {
  reason: string;
  message: string;
  turnIndex: number;
}

interface SteerUpDecision {
  messageToSend: string | null;
  nextPending: PendingSteerUp | null;
}

interface SteerUpCooldown {
  cooldownMs: number;
  lastSteerUpAt: number;
  now: number;
}

interface DetectionState {
  history: TurnSummary[];
  nudgesSent: number;
  pendingSteerUp: PendingSteerUp | null;
}

interface TaskCompleteResetResult {
  state: DetectionState;
  hadPendingSteerUp: boolean;
}

const DEFAULT_CONFIG: StuckConfig = {
  maxReadRepeats: 10,
  maxErrorRepeats: 2,
  maxNoMutationTurns: 7,
  maxToolsPerTurn: 45,
  steerUpCooldownMs: 5 * 60 * 1000,
  nudgeMessage: "⚠️ You've been going in circles. Consider: (1) simplify the approach, (2) ask the user for clarification, or (3) try a completely different strategy.",
  autoNudge: true,
  autoCompact: false,
  debug: false,
};

const STEER_UP_UI_KEY = "stuck-monitor-steer-up";

export default function (pi: ExtensionAPI) {
  const config: StuckConfig = DEFAULT_CONFIG;
  pi.registerFlag("stuck-steer-up-cooldown-minutes", {
    description: "Minimum minutes between automatic stuck-monitor steer-ups",
    type: "string",
    default: String(config.steerUpCooldownMs / 60_000),
  });

  let currentTurn: TurnState | null = null;
  let history: TurnSummary[] = [];
  let totalTurns = 0;
  let nudgesSent = 0;
  let pendingSteerUp: PendingSteerUp | null = null;
  let lastSteerUpAt = 0;
  let steerUpCooldownOverrideMs: number | null = null;

  // ──────────────────────────────────────────
  // Session lifecycle
  // ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    history = [];
    totalTurns = 0;
    nudgesSent = 0;
    pendingSteerUp = null;
    lastSteerUpAt = 0;
    clearSteerUpUi(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Task completed: reset detection state so the next task starts with a clean
    // slate. Without this, history (no-mutation streaks, error streaks, repeated
    // reads) carries over and the next task immediately trips false positives.
    // lastSteerUpAt is intentionally preserved so the cooldown stays wall-clock.
    const { state, hadPendingSteerUp } = resetStateOnTaskComplete({
      history,
      nudgesSent,
      pendingSteerUp,
    });
    history = state.history;
    nudgesSent = state.nudgesSent;
    pendingSteerUp = state.pendingSteerUp;

    clearSteerUpUi(ctx);

    if (hadPendingSteerUp) {
      ctx.ui.notify("✅ Task completed; removed pending stuck-monitor steer-up", "info");
    }
  });

  // ──────────────────────────────────────────
  // Turn tracking
  // ──────────────────────────────────────────

  pi.on("turn_start", async (event, ctx) => {
    currentTurn = {
      turnIndex: event.turnIndex,
      toolCalls: [],
      startTime: Date.now(),
    };

    // Reset any pending stuck warning from previous turns — each turn starts fresh
    if (pendingSteerUp) {
      pendingSteerUp = null;
      clearSteerUpUi(ctx);
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!currentTurn) return;

    currentTurn.toolCalls.push({
      name: event.toolName,
      input: event.input as Record<string, unknown>,
    });

    if (config.debug) {
      console.log(
        `[stuck-monitor] tool_call #${currentTurn.toolCalls.length}: ${event.toolName}`,
        JSON.stringify(event.input),
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!currentTurn) return;
    const last = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
    if (last) {
      last.result = {
        isError: event.isError,
        truncated: event.result?.truncated ?? false,
      };
    }

    // Intra-turn: too many tools = probably circular thinking
    if (currentTurn.toolCalls.length >= config.maxToolsPerTurn) {
      const reason = `turn exceeded ${config.maxToolsPerTurn} tool calls (${currentTurn.toolCalls.length} so far)`;
      const cooldownActive = isSteerUpCooldownActive({
        cooldownMs: getSteerUpCooldownMs(pi, config, steerUpCooldownOverrideMs),
        lastSteerUpAt,
        now: Date.now(),
      });
      if (!pendingSteerUp && cooldownActive) {
        ctx.ui.setStatus("stuck-monitor", "⚠️ steer-up cooldown active");
      } else if (!pendingSteerUp || pendingSteerUp.turnIndex !== currentTurn.turnIndex) {
        ctx.ui.notify(
          `⚠️ Steer-up armed: ${reason} — possible circular thinking`,
          "warning",
        );
        if (config.autoNudge) {
          pendingSteerUp = {
            reason,
            message:
              "You've made many tool calls in this single turn. Step back and focus on ONE concrete next action. If the task is complete, finish now instead.",
            turnIndex: currentTurn.turnIndex,
          };
          showSteerUpUi(ctx, pendingSteerUp);
        }
      } else if (config.autoNudge) {
        pendingSteerUp = { ...pendingSteerUp, reason };
        showSteerUpUi(ctx, pendingSteerUp);
      }
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!currentTurn) return;
    totalTurns++;

    const readPaths = currentTurn.toolCalls
      .filter((tc) => tc.name === "read")
      .map((tc) => (tc.input.path as string) || "unknown");

    const summary: TurnSummary = {
      turnIndex: currentTurn.turnIndex,
      toolCount: currentTurn.toolCalls.length,
      mutations: currentTurn.toolCalls.filter(
        (tc) => tc.name === "edit" || tc.name === "write",
      ).length,
      errors: currentTurn.toolCalls.filter((tc) => tc.result?.isError).length,
      readPaths,
      duration: Date.now() - currentTurn.startTime,
    };

    history.push(summary);
    if (history.length > 20) history.shift(); // rolling window

    const reason = detectStuck(history, summary, config);
    if (reason) {
      nudgesSent++;
      ctx.ui.notify(`⚠️ Stuck detected (${nudgesSent}x): ${reason}`, "warning");

      if (config.autoNudge) {
        if (
          isSteerUpCooldownActive({
            cooldownMs: getSteerUpCooldownMs(pi, config, steerUpCooldownOverrideMs),
            lastSteerUpAt,
            now: Date.now(),
          })
        ) {
          ctx.ui.setStatus("stuck-monitor", "⚠️ steer-up cooldown active");
        } else {
          pendingSteerUp = {
            reason,
            message: `${config.nudgeMessage} (Stuck reason: ${reason}) If the task is complete, finish now instead.`,
            turnIndex: currentTurn.turnIndex,
          };
          showSteerUpUi(ctx, pendingSteerUp);
        }
      }

      if (config.autoCompact) {
        ctx.compact({
          customInstructions:
            "The agent was stuck in a loop. Summarize the current state and the single most important next step.",
          onComplete: () =>
            ctx.ui.notify("Auto-compacted after stuck detection", "success"),
          onError: (err) =>
            ctx.ui.notify(`Compact failed: ${err.message}`, "error"),
        });
      }
    }

    const decision = resolveSteerUpAfterTurn(pendingSteerUp, event.toolResults.length > 0, {
      cooldownMs: getSteerUpCooldownMs(pi, config, steerUpCooldownOverrideMs),
      lastSteerUpAt,
      now: Date.now(),
    });
    pendingSteerUp = decision.nextPending;
    if (decision.messageToSend) {
      clearSteerUpUi(ctx);
      pi.sendUserMessage(decision.messageToSend, { deliverAs: "steer" });
      lastSteerUpAt = Date.now();
      ctx.ui.notify("⚠️ Stuck-monitor steer-up delivered", "warning");
    } else if (!pendingSteerUp) {
      clearSteerUpUi(ctx);
    }

    currentTurn = null;
  });

  // ──────────────────────────────────────────
  // Manual commands
  // ──────────────────────────────────────────

  pi.registerCommand("nudge", {
    description: "Manually nudge the agent when it seems stuck",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(
        "Focus on making concrete progress. What's the simplest next step you can take?",
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Nudge sent to agent", "success");
    },
  });

  pi.registerCommand("stuck-status", {
    description: "Show stuck-monitor statistics",
    handler: async (_args, ctx) => {
      const last5 = history.slice(-5);
      const uniqueReads = new Set<string>();
      let mutations = 0;
      let errors = 0;
      for (const t of last5) {
        for (const p of t.readPaths) uniqueReads.add(p);
        mutations += t.mutations;
        errors += t.errors;
      }
      ctx.ui.notify(
        `Last ${last5.length} turns: ${mutations} mutations, ${uniqueReads.size} unique files read, ${errors} errors. Total nudges: ${nudgesSent}`,
        "info",
      );
    },
  });

  pi.registerCommand("stuck-config", {
    description: "Show current stuck-monitor thresholds",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `maxReadRepeats=${config.maxReadRepeats} maxErrorRepeats=${config.maxErrorRepeats} maxNoMutationTurns=${config.maxNoMutationTurns} maxToolsPerTurn=${config.maxToolsPerTurn} steerUpCooldownMs=${getSteerUpCooldownMs(pi, config, steerUpCooldownOverrideMs)} autoNudge=${config.autoNudge} autoCompact=${config.autoCompact}`,
        "info",
      );
    },
  });

  pi.registerCommand("stuck-cooldown", {
    description: "Set steer-up cooldown in minutes for this session",
    handler: async (args, ctx) => {
      const minutes = Number(args.trim());
      if (!Number.isFinite(minutes) || minutes < 0) {
        ctx.ui.notify("Usage: /stuck-cooldown <minutes>, for example /stuck-cooldown 5", "error");
        return;
      }

      steerUpCooldownOverrideMs = Math.round(minutes * 60_000);
      ctx.ui.notify(`Stuck-monitor steer-up cooldown set to ${minutes} minute(s)`, "success");
    },
  });
}

// ──────────────────────────────────────────
// Detection heuristics
// ──────────────────────────────────────────

function detectStuck(
  history: TurnSummary[],
  current: TurnSummary,
  config: StuckConfig,
): string | null {
  // 1. Same file read repeatedly across recent turns with zero edits
  const recentReads = new Map<string, number>();
  let recentMutations = 0;
  const windowSize = Math.min(history.length, config.maxReadRepeats + 1);
  for (let i = history.length - 1; i >= history.length - windowSize; i--) {
    for (const path of history[i].readPaths) {
      recentReads.set(path, (recentReads.get(path) || 0) + 1);
    }
    recentMutations += history[i].mutations;
  }
  for (const [path, count] of recentReads) {
    if (count >= config.maxReadRepeats && recentMutations === 0) {
      return `read "${path}" ${count}x without editing`;
    }
  }

  // 2. Consecutive turns with errors
  let errorStreak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].errors > 0) errorStreak++;
    else break;
  }
  if (errorStreak >= config.maxErrorRepeats) {
    return `${errorStreak} consecutive error turns`;
  }

  // 3. Many turns with no file mutations at all
  let noMutationStreak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].mutations === 0) noMutationStreak++;
    else break;
  }
  if (noMutationStreak >= config.maxNoMutationTurns) {
    return `${noMutationStreak} turns without file changes`;
  }

  // 4. Circular reading: many reads in current turn, few unique files, zero edits
  const uniqueReads = new Set(current.readPaths);
  if (
    current.readPaths.length > uniqueReads.size * 2 &&
    current.readPaths.length > 4 &&
    current.mutations === 0
  ) {
    return `circular reading: ${current.readPaths.length} reads, only ${uniqueReads.size} unique files`;
  }

  return null;
}

export function resolveSteerUpAfterTurn(
  pending: PendingSteerUp | null,
  agentWillContinue: boolean,
  cooldown?: SteerUpCooldown,
): SteerUpDecision {
  if (!pending) {
    return { messageToSend: null, nextPending: null };
  }

  if (!agentWillContinue) {
    return { messageToSend: null, nextPending: null };
  }

  if (cooldown && isSteerUpCooldownActive(cooldown)) {
    return { messageToSend: null, nextPending: null };
  }

  return { messageToSend: pending.message, nextPending: null };
}

export function resetStateOnTaskComplete(
  state: DetectionState,
): TaskCompleteResetResult {
  return {
    state: {
      history: [],
      nudgesSent: 0,
      pendingSteerUp: null,
    },
    hadPendingSteerUp: state.pendingSteerUp !== null,
  };
}

export function isSteerUpCooldownActive(cooldown: SteerUpCooldown): boolean {
  if (cooldown.cooldownMs <= 0 || cooldown.lastSteerUpAt <= 0) {
    return false;
  }

  return cooldown.now - cooldown.lastSteerUpAt < cooldown.cooldownMs;
}

function getSteerUpCooldownMs(
  pi: ExtensionAPI,
  config: StuckConfig,
  overrideMs: number | null,
): number {
  if (overrideMs !== null) {
    return overrideMs;
  }

  const flagValue = pi.getFlag("stuck-steer-up-cooldown-minutes");
  const flagMinutes =
    typeof flagValue === "string" ? Number(flagValue) : Number.NaN;
  if (Number.isFinite(flagMinutes) && flagMinutes >= 0) {
    return Math.round(flagMinutes * 60_000);
  }

  return config.steerUpCooldownMs;
}

function showSteerUpUi(ctx: ExtensionContext, pending: PendingSteerUp) {
  ctx.ui.setStatus("stuck-monitor", `⚠️ steer-up armed: ${pending.reason}`);
  ctx.ui.setWidget(
    STEER_UP_UI_KEY,
    [
      "⚠️ STUCK MONITOR: STEER-UP ARMED",
      `Reason: ${pending.reason}`,
      "The steer-up will be removed automatically if the task completes first.",
    ],
    { placement: "aboveEditor" },
  );
}

function clearSteerUpUi(ctx: ExtensionContext) {
  ctx.ui.setStatus("stuck-monitor", undefined);
  ctx.ui.setWidget(STEER_UP_UI_KEY, undefined);
}
