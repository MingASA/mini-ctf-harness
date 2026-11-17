# Construct and validate a ROP stage

For AMD64 SysV scalar calls, arguments normally use RDI, RSI, RDX, RCX, R8, R9. Raw Linux syscalls instead use R10 for the fourth argument and take the syscall number in RAX. Choose the actual ABI; library calls and syscalls are not interchangeable instructions.

## Use pwntools to lay out the chain
This fragment takes the measured overwrite `offset`, callable `target` address, and `arguments` list. Set those from the actual binary and runtime before executing it.
```python
from pathlib import Path
from pwn import ELF, ROP, context, flat
elf = context.binary = ELF('./program', checksec=False)
# Inputs: offset, target, arguments, and (for PIE) the measured load_base.
# Assign elf.address = load_base before constructing ROP for a PIE image.
rop = ROP(elf)
rop.call(target, arguments)
payload = flat(b'A' * offset, rop.chain())
print(rop.dump())
Path('payload.bin').write_bytes(payload)
```
When that image lacks a suitable gadget, inspect another available image or select a different primitive. Verify candidate bytes, side effects, extra pops, memory accesses, and stack movement. Unaligned instruction starts are valid candidates on x86 when decoded and executable at that address.

## Alignment and continuation
Calculate the stack position at each function entry. For a normal AMD64 SysV scalar call, the entry RSP modulo 16 is 8. An extra `ret` changes it by eight bytes, but should be added only when the chain requires it. Avoid treating an alignment fix as a universal remedy for any crash.

Choose a continuation that provides a real next input or clean exit. Returning to `main`, a vulnerable function, or a call site each has different stack and initialization requirements. Inspect what that destination expects; no one reentry point is universally best.

## Leaks and library bases
Use a leak whose representation and width are understood. Derive a base from a symbol offset in the matching library, then cross-check a second symbol, mapping, or expected bytes when available. A matching page offset alone is weak identification. PLT/GOT behavior and lazy binding can change what an early leak points to.

Construct the dependent stage within the appropriate process lifetime. Check the actual return/output before proceeding. Raw syscalls still obey seccomp and hardware constraints; switching from libc to `syscall` is a new strategy requiring evidence, not a general bypass.

Primary references: [pwntools ROP](https://docs.pwntools.com/en/stable/rop/rop.html), [Linux syscall ABI](https://man7.org/linux/man-pages/man2/syscall.2.html).
