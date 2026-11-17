---
name: ctf-pwntools-io
description: Build reliable local-process or TCP interactions with pwntools, including binary sends, prompts, fixed-length
  leaks, menus, and staged payloads. Use when an exploit hangs, reads partial data, loses synchronization, or needs
  a reusable I/O driver. For HTTP application requests use ctf-http-replay.
---

# Pwntools Process and Socket Interaction

Make the byte exchange reproducible so the exploit can advance through its stages.

## Start
Identify the input protocol: line-delimited, fixed-length, length-prefixed, or read-until-EOF. Use one pwntools tube API for the local and remote drivers. Save transmitted payloads and the received bytes needed for parsing.

## Choose a reference
- Choosing send/receive calls, delimiters, lengths, EOF, or timeouts: [framing-and-tubes.md](references/framing-and-tubes.md).
- Menus, partial leaks, multiple stages, buffering, and local/remote differences: [staged-interactions.md](references/staged-interactions.md).

## Build and use the driver
1. Reproduce one ordinary exchange before sending a larger payload.
2. Send the exact input required by that protocol and receive only the bytes belonging to the current phase.
3. Check a delimiter or required length before advancing. On a timeout, retain buffered data and inspect the current phase.
4. Parse the result into bytes or integers, then construct the next payload from verified values.
5. Keep the connection alive when later stages depend on its process state; reconnect only when the protocol or recovery plan calls for it.

The result is a short working driver, not an interactive terminal left awaiting human input. Finish by recording the requested program effect or returned data and continue the solve.
