# Pi Stuck Monitor

Pi extension that detects repetitive agent behavior and sends a rate-limited steer-up nudge when the agent appears stuck.

## What It Detects

- Repeated reads of the same file without edits
- Consecutive turns with tool errors
- Many turns without file mutations
- Circular reading patterns
- Too many tool calls in a single turn

When a stuck pattern is detected, the extension arms a prominent steer-up UI. If the task completes first, the pending steer-up is removed. If the agent continues, the steer-up is delivered with a configurable cooldown to avoid repeated interruptions.

## Install From Git

```bash
pi install git:https://github.com/YOUR_USER/pi-stuck-monitor.git
```

Then reload pi:

```bash
/reload
```

## Local Development

```bash
cd ~/.pi/agent/extensions/stuck-monitor
npm install
npm test
```

## Commands

```bash
/nudge              # Manually send a nudge to the agent
/stuck-status       # Show recent turn stats
/stuck-config       # Show thresholds and cooldown
/stuck-cooldown 5   # Set steer-up cooldown to 5 minutes for this session
```

## Configuration

The package exposes a pi flag for install-time or launch-time configuration:

```bash
pi --stuck-steer-up-cooldown-minutes 5
```

Defaults live in `index.ts`:

| Constant | Default | Meaning |
| --- | ---: | --- |
| `maxReadRepeats` | `10` | Same file read count with no edits |
| `maxErrorRepeats` | `2` | Consecutive error turns |
| `maxNoMutationTurns` | `7` | Turns without file changes |
| `maxToolsPerTurn` | `45` | Tool calls in a single turn |
| `steerUpCooldownMs` | `300000` | Minimum time between automatic steer-ups |
| `autoNudge` | `true` | Send steer-up automatically |
| `autoCompact` | `false` | Auto-trigger compaction when stuck |

## Publishing

This folder is a standalone pi package. Put it in a git repository and publish the repository URL. Pi discovers the extension through the `pi.extensions` entry in `package.json`.
