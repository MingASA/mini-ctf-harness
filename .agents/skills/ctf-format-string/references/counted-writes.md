# Plan writes by byte count, width, and destination

`%n` stores the number of bytes produced so far by that format invocation, not the string length of the payload or output accumulated by previous calls. A literal prefix inside the same format contributes to that count; an earlier separate print call does not.

On the usual Linux x86-64 C ABI, `%hhn`, `%hn`, `%n`, and `%lln` target one, two, four, and eight bytes respectively. Confirm the selected runtime/ABI. A pointer-sized destination does not require one enormous pointer-sized count; partial writes can be appropriate when preserved bytes are known.

## Compute a small schedule
For a k-byte atom, choose padding modulo `2**(8*k)` and account for every preceding literal/output byte. A zero padding increment needs no `%0c` trick. Changing payload length can move appended addresses and therefore change argument positions.

```python
# Padding arithmetic for two one-byte write targets.
count = 18
wanted = [41, 7]
padding = []
for value in wanted:
    delta = (value - count) % 256
    padding.append(delta)
    count += delta
assert padding == [23, 222]
```

Use `fmtstr_payload` with an observed offset, real destination, intended write bytes, and the correct `numbwritten`. Set pwntools architecture first. Integer values may be expanded to the context word width; explicit packed bytes express the intended destination extent more clearly. Inspect the generated payload before sending.

A payload-construction fragment using measured inputs:
```python
from pathlib import Path
from pwn import ELF, context, fmtstr_payload
context.binary = ELF('./program', checksec=False)
# Inputs: fmt_offset, destination, write_bytes, and prefix_count.
# write_bytes is the exact intended byte string, not an unbounded integer.
payload = fmtstr_payload(fmt_offset, {destination: write_bytes},
                         numbwritten=prefix_count, write_size='byte')
Path('format-payload.bin').write_bytes(payload)
```
Set `prefix_count` to bytes already produced by this same formatting call. For a direct call on the payload with no preceding output in that call, it is zero. Re-measure the argument position if the layout changes.

## Check the writable target and budget
Full RELRO normally makes GOT targets unsuitable for writes. Look at the actual mapping and program use of the proposed destination. Fortified formatting can reject `%n` in some configurations. Large padding can exceed output/time limits even when arithmetic is correct; prefer small atom writes when the primitive permits them.

Finally, read back the changed memory in a local debugger or observe a deterministic program effect. A connection closure alone does not tell whether the write happened or which byte was wrong.

Primary references: [pwntools format payloads](https://docs.pwntools.com/en/stable/fmtstr.html), [printf](https://man7.org/linux/man-pages/man3/printf.3.html).
