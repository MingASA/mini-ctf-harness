# Match the runtime that the input is supposed to affect

Record the binary hash, architecture, interpreter, required libraries, argv, environment, cwd, input channel, and process lifetime. Only investigate differences that can affect the observed behavior.

## PIE and ASLR
Use `info proc mappings` and the relevant PT_LOAD segment to establish a load bias. Offsets from an ELF and absolute live addresses are not interchangeable. GDB commonly disables randomization for local runs; check `show disable-randomization`. Use `set disable-randomization off` when reproducing normal ASLR behavior matters. The setting can fail in a restricted container, so inspect the actual mappings.

## Supplied loader and libc
Use a matching loader/library set when the task provides one:
```bash
"$LOADER" --library-path "$LIBDIR" ./program
```
This example is for a compatible glibc loader. Inspect its local help and verify architecture. `LD_PRELOAD` alone does not necessarily create a compatible old-runtime environment. Confirm loaded objects with mappings; prefer supplied binaries or a matching existing container over mixing arbitrary library versions.

A function leak identifies a runtime address, not a library build by itself. Check the supplied library or additional independent symbols before computing other addresses. Returning to an earlier function does not guarantee the program state is suitable for another input; inspect initialization, file descriptors, and persistent counters.

## Process and transport differences
PTYs can alter buffering; pipes can expose short reads; remote wrappers may fork or restart per connection. A new connection may imply new addresses, but a forking server can share inherited state. Determine which model the service actually uses.

If the observation tool cannot attach, distinguish ptrace restrictions from a program crash. Use an existing core, `strace`, or static analysis for a narrower question. A missing debugger is an environment issue, not proof the candidate input is wrong.

Primary references: [GDB starting a program](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Starting.html), [Linux dynamic linker](https://man7.org/linux/man-pages/man8/ld.so.8.html).
