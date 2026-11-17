---
name: ctf-stack-rop
description: Build and debug stack-overflow, ret2win, ROP, and ret2libc exploits with pwntools and GDB. Use when
  a native program has a stack overwrite or controlled return and a callable function, leak, or syscall can advance
  the solve. For a printf-controlled format string use ctf-format-string.
---

# Stack Exploitation and ROP

Turn a measured overwrite into a working payload and verify each required stage.

## Start
Identify the input operation, overwrite extent, architecture, and protections. Determine the smallest useful control-flow destination or callable primitive before choosing a longer chain.

## Choose a reference
- Finding an overwrite offset, confirming control, and respecting payload bytes: [offset-and-control.md](references/offset-and-control.md).
- Function calls, gadgets, stack alignment, staged leaks, and libc resolution: [rop-construction.md](references/rop-construction.md).

## Build the exploit
1. Measure the control offset and confirm it using a distinct payload.
2. Derive runtime addresses from the current process or supplied image/library. Set pwntools architecture and load bases before packing values.
3. Build the shortest chain that produces useful output or reaches the objective. Inspect `ROP.dump()` and every gadget's side effects.
4. Break at the decisive instruction or call to verify arguments, stack, and return path.
5. Replay the validated stages through the actual service protocol and collect the resulting data or program effect.

Use ctf-pwntools-io for synchronization and ctf-gdb-debugging for live-state questions. Keep the working primitive while changing only the stage that the evidence shows is broken.
