# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

Use GitHub's private vulnerability reporting for this repository:
go to the **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what you think the impact is.

## Scope

These parts of noprod are in scope:

- the web app (`apps/frontend`);
- the dictation service (`apps/orchestrator`, and whatever replaces it);
- GhostDAW, the native audio host (`apps/audio_core`);
- the plugins in [agentchieflou/v-loudio-t](https://github.com/agentchieflou/v-loudio-t).

## Running noprod safely

GhostDAW and the local services are meant to run on your own machine, or behind
authentication. Do not expose them directly to a network you don't control.
