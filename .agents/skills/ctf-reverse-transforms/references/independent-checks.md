# Verify candidates without verifying only the same mistake

## Prefer a separate oracle
The best check is the supplied executable or original forward code on the recovered bytes. A second Python implementation copied from the first is not independent. With only disassembly, compare a few intermediate states against GDB stops or captured input/output pairs.

Use boundary inputs to challenge translation choices: zero, a high bit, the maximum value of an element, repeated elements, and values around a branch boundary. Use a short deterministic random sample for broader coverage. These checks validate a model; they do not establish that an arbitrary long algorithm is correct for every input.

For a permutation, check that every source position appears exactly once. For a recurrence, compare intermediate states before comparing final text. For a non-injective operation, retain every feasible preimage until another constraint resolves it.

## Treat text as an interpretation
A readable string is evidence of plausibility, not proof. A byte sequence may contain zero bytes, a trailing newline, or non-UTF-8 bytes. Use `repr`, hexadecimal, byte length, and a raw output file. Decode with an explicitly chosen codec only when the format or consumer requires it.

```python
from pathlib import Path
raw = bytes([0, 65, 10, 255])
Path('candidate.bin').write_bytes(raw)
assert Path('candidate.bin').read_bytes() == raw
print(len(raw), raw.hex(), repr(raw))
```
Avoid `.strip()` on binary data. For a text protocol, remove only the framing bytes the protocol actually defines. Preserve case and other characters unless the transformation itself changes them.

## Resolve partial success
If the reconstructed function matches the target but the executable rejects the candidate, inspect input framing, length checks, unmodeled preprocessing, and a later predicate. Compare the first disagreeing intermediate state rather than rewriting the whole solver.

If several candidates pass the modeled check, test additional original constraints. Report an equivalence class when the task truly leaves it ambiguous. Do not add an attractive-looking prefix as a mathematical constraint without task evidence.

Primary references: [Python binary sequences](https://docs.python.org/3/library/stdtypes.html#binary-sequence-types-bytes-bytearray-memoryview), [struct byte order](https://docs.python.org/3/library/struct.html#byte-order-size-and-alignment).
