---
name: ctf-gdb-debugging
description: Reproduce native-program crashes and inspect live registers, memory, branches, and library mappings
  with GDB. Use for a core dump, an unexpected return or syscall result, a failing exploit stage, or local/remote
  runtime differences. For static binary identification use ctf-binary-recon.
---

# GDB Runtime Debugging

Answer a concrete runtime question with a reproducible stop and a small state snapshot.

## Start
Save program input as bytes. Keep GDB commands in a separate file. Choose the stop that will answer the question: a symbol, instruction, signal, or watched memory location.

```bash
gdb -q -batch -x inspect.gdb --args ./program
```

## Choose a reference
- Replaying input, selecting breakpoints, reading a crash, or watchpoints: [replay-and-stops.md](references/replay-and-stops.md).
- Function calls, syscalls, register arguments, stack alignment, or instruction semantics: [machine-state.md](references/machine-state.md).
- PIE/ASLR, supplied libraries, loader failures, or environment differences: [runtime-matching.md](references/runtime-matching.md).

## Debug the failing step
1. State the expected instruction or state transition and select a stop immediately before or after it.
2. Run the same input and capture the PC, relevant registers, bounded memory, and the actual stop reason.
3. Compare expected and observed values. Check argument memory and return values, not just the destination address.
4. Change the input or model based on that observation, then reproduce once more.

Keep a small command file and input artifact that regenerate the observation. When ptrace or a loader is unavailable, record that tool failure separately and use static inspection or an available execution trace for the next question.
