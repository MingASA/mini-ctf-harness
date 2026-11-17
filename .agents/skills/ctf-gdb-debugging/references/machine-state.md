# Check machine state at a known instruction

## Linux x86-64 scalar calling conventions
| Operation | Arguments | Number / result | Important distinction |
|---|---|---|---|
| SysV function call | RDI, RSI, RDX, RCX, R8, R9 | Result usually RAX | Additional arguments use stack; aggregates/floats have other rules |
| Linux `syscall` instruction | RDI, RSI, RDX, R10, R8, R9 | Number RAX; result RAX | RCX and R11 are clobbered |

Use this table only for the named architecture and ABI. Fetch syscall constants for the target architecture rather than transferring a number from another ABI. A raw Linux syscall failure usually returns a negative errno value; libc wrappers commonly expose `-1` and set `errno`.

For an ordinary SysV AMD64 call, RSP is 16-byte aligned immediately before `call`, and RSP modulo 16 is 8 at function entry after the return address is pushed. Wider vector stack arguments and other ABIs require their own rules. ROP must recreate the relevant entry condition; an extra `ret` is useful only when it actually fixes the calculated alignment.

## Inspect values and pointed-to memory
At the selected call, record the argument registers and bounded memory they reference. `x/s` is appropriate for a terminated string, while `x/Nbx` preserves embedded zeros and exact bytes. Compare the actual input length, pointer validity, mapping permissions, and result register. A 32-bit write to an x86-64 general register zero-extends into its 64-bit register; operand size matters.

A gadget must have usable live bytes, the intended decoded instructions, satisfied memory operands, and accounted stack consumption. x86 decoding can begin at any byte address, although the resulting instruction stream still needs verification. Check instruction side effects and the dynamic control path separately.

## Use the failure location
A fault loading an argument, a fault at an aligned SIMD instruction, and a negative syscall return are different failures. Diagnose the relevant condition before switching the whole exploit strategy. A raw syscall is not a general bypass for seccomp or hardware control-flow protections.

Primary references: [Linux syscall ABI](https://man7.org/linux/man-pages/man2/syscall.2.html), [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI).
