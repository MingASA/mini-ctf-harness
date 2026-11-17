# Measure a stack overwrite

Inspect the input operation and buffer layout. Line input, bounded read, formatted input, and an unchecked copy have different constraints. Record maximum accepted length, terminators, transformed bytes, canaries, and which object the write can reach.

## Use a consistent cyclic pattern
```python
from pathlib import Path
from pwn import cyclic, cyclic_find
pattern = cyclic(320, n=8)
Path('pattern.bin').write_bytes(pattern)
# For bytes recovered from the actual overwritten slot:
# offset = cyclic_find(observed_bytes, n=8)
```
Choose the pattern size to fit the tested input. The `n` and alphabet used to search must match generation. For partial observations, determine whether the available bytes uniquely identify an offset; do not silently search a different pattern order.

In GDB, inspect the actual saved return slot or indirect target associated with the crash. The PC can remain at `ret` when a non-canonical target faults. A corrupted local variable or frame pointer is useful information but is not automatically control of the return address.

## Confirm the offset
Construct a second payload with the measured padding and an identifiable value or a known local breakpoint destination. Verify the intended slot and execution transition. Keep surrounding stack requirements valid when the program checks a canary or uses locals before returning.

## Match payload constraints
Set `context.binary = ELF('./program', checksec=False)` before packing. Use `flat`, `p32`, and `p64` with the target width and endian. Check total length and forbidden bytes after assembling the full payload, including addresses. A newline delimiter may not count toward the payload buffer, while a NUL can terminate a string copy.

Prefer a reachable existing function when it satisfies the objective. NX and ASLR influence strategy but do not create an exploit by themselves. If the overwrite does not reach a control object, reconsider the primitive instead of merely lengthening the payload.

Primary references: [pwntools cyclic](https://docs.pwntools.com/en/stable/util/cyclic.html), [pwntools packing](https://docs.pwntools.com/en/stable/util/packing.html).
