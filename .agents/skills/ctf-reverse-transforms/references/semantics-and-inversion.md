# Preserve semantics before inverting

## Build the forward model
Record the width at each operation, not just the destination variable. Python integers are unbounded. C integer promotions, signed/unsigned comparisons, machine instruction widths, and narrowing stores can all change the result. Apply a mask where the original computation truncates; an early mask can erase a carry that the original code uses.

Distinguish arithmetic and logical right shift. For an unsigned w-bit value, normalize with `x & ((1 << w) - 1)` before shifting. Convert to a signed representative only where the original operation is signed. A decompiler's cast is a hypothesis until checked against the instruction or a runtime value.

Extract constants as bytes or explicit integers. Endianness changes integer interpretation, not the order of bytes already stored in a buffer. Treat a lookup table's index and its value as different quantities.

## Select an inverse
| Forward operation | Inverse or necessary condition |
|---|---|
| XOR with a known value | XOR with the same value |
| Addition modulo m | Subtract modulo m |
| Multiplication modulo m | Multiply by an inverse only when `gcd(a, m) == 1` |
| Bit rotation | Opposite rotation at the same width |
| `out[i] = inp[p[i]]` | Assign `inp[p[i]] = out[i]`; verify p is a permutation |
| Table lookup | Build all preimages; duplicate entries make inversion ambiguous |
| Lossy mask, truncation, or hash | Preserve constraints or enumerate missing information |

For a composition, reverse both the operation order and each operation. For a rolling state, explicitly list whether step i reads the prior state, prior input, or prior output. In-place code can mix old and updated elements within one iteration; reversing the loop alone is not a proof of inversion.

## Small executable example
This affine word transform has a genuine inverse:
```python
from math import gcd
modulus = 1 << 16
a, b = 13, 29
assert gcd(a, modulus) == 1
ainv = pow(a, -1, modulus)
def encode_word(x):
    return (a * x + b) % modulus
def decode_word(y):
    return ((y - b) * ainv) % modulus
for x in (0, 1, 32767, 32768, 65535):
    assert decode_word(encode_word(x)) == x
```
If the multiplier were even, modular inversion over `2**16` would fail. That is a change in the mathematical problem, not a reason to force `pow` to produce an answer.

Primary references: [Python integer operations](https://docs.python.org/3/library/stdtypes.html#numeric-types-int-float-complex), [Python pow](https://docs.python.org/3/library/functions.html#pow).
