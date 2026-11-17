# Reproduce an execution and stop deliberately

An example command file for a symbolized Linux x86-64 program:
```gdb
set pagination off
set confirm off
set disassembly-flavor intel
break main
run < input.bin
x/i $pc
info registers
x/16gx $sp
bt
```
Replace `main` with a real symbol or resolved runtime address. On another architecture omit the Intel syntax setting and choose the appropriate memory width. For a stripped PIE, `starti`, `info files`, and `info proc mappings` can establish the loaded image before setting a runtime breakpoint.

## Select the observation
| Question | Stop / inspection |
|---|---|
| Which instruction faults? | Run to the signal; `x/i $pc`, `bt`, registers |
| What bytes reached a parser? | Break at its entry; inspect buffer and length |
| Which write changes a value? | `watch` the resolved object; continue to the write |
| What does a call return? | Step to after the call or `finish` the function |
| Did input change a branch? | Stop before comparison/jump; inspect operands and flags |

`si` enters calls instruction by instruction; `ni` steps over a call. A breakpoint after a non-returning operation is not expected to be reached. Forking programs may require an intentional `set follow-fork-mode child` and a known process to observe.

## Input and output
`run < input.bin` redirects the inferior's input. GDB still reads debugger commands from its command file/terminal. For a real terminal-dependent program, `set inferior-tty` points to a prepared terminal; it is not necessary for ordinary binary stdin. Keep input files unchanged between comparisons.

For `gdb ./program corefile`, verify the executable matches the core. A core captures a specific process state; addresses are not automatically reusable in a new ASLR run. Inspect `info registers`, mappings, and only the memory range relevant to the fault.

A non-canonical return target on x86-64 can fault at the `ret` instruction while RIP still names `ret`; inspect the stack's return slot and signal context. A repeated byte pattern somewhere in a register does not by itself identify the overwritten return slot.

Primary reference: [GDB program I/O](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Input_002fOutput.html).
