---
name: ctf-format-string
description: Exploit attacker-controlled printf-style format strings to leak values, read memory, or perform measured
  writes. Use for percent directives interpreted by a native format function, format-argument offset discovery,
  and %n-based writes. A buffer overflow or a language template is a different primitive.
---

# Format-String Exploitation

Establish the format primitive, measure its argument layout, and use a verified read or write to advance the task.

## Start
Determine whether input is the format string itself or a normal data argument. Identify the format-function family, output channel, architecture, input transformations, and process lifetime.

## Choose a reference
- Establishing interpretation, finding argument positions, or reading values: [argument-layout-and-reads.md](references/argument-layout-and-reads.md).
- Counting output, choosing write width, generating payloads, and readback: [counted-writes.md](references/counted-writes.md).

## Exploit the measured primitive
1. Use a small marked probe to identify where controlled input or useful values appear.
2. Validate one leak/read and its process context before using it to compute addresses.
3. For a write, establish a useful writable destination, its initial bytes, the required change, and the relevant printed-byte count.
4. Generate a payload with pwntools or calculate the small write schedule explicitly. Inspect resulting bytes and length.
5. Verify the write in memory or through a deterministic program effect, then complete the challenge path.

A successful formatted leak does not imply an arbitrary write. Keep offsets tied to the actual format call and payload layout, and recheck after changing wrappers or alignment.
