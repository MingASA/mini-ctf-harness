# Choose and encode the mathematical problem

## Start with the cheapest adequate method
A small independent domain is often easier to enumerate than to encode in SMT. A linear modular equation may have an explicit inverse; test the gcd condition first. SymPy `linsolve` or exact rationals can handle linear algebra without rounding. Nonlinear expressions, cryptographic hashes, and very large domains do not become tractable merely by placing them in Z3.

Use Z3 `Int` for unbounded integer arithmetic, and `BitVec` for fixed-width machine arithmetic. Bit-vector addition and multiplication wrap; Int arithmetic does not. A comparison such as `x < y` on bit-vectors is signed in Z3Py. Use `ULT`, `ULE`, `UGT`, or `UGE` for unsigned comparisons, and `LShR` for a logical right shift. Explicitly extend or extract values where the source changes width.

Division and remainder deserve separate attention: a high-level language, a machine instruction, and mathematical integers may use different conventions for negative operands. Translate the original behavior rather than assuming Python `%` matches every target.

## A complete small model
This small example combines byte arithmetic, an unsigned bound, and a logical shift:
```python
from z3 import BitVec, Solver, ULE, LShR, sat, unsat
x = BitVec('x', 8)
s = Solver()
s.set(timeout=1500)
s.add(ULE(x, 200), (x * 5 + 9) == 144, LShR(x, 4) == 1)
status = s.check()
if status == sat:
    value = s.model().eval(x, model_completion=True).as_long()
    assert value <= 200
    assert ((value * 5 + 9) & 255) == 144
    assert (value >> 4) == 1
    print(value)
elif status == unsat:
    print('No solution to the encoded constraints')
else:
    print('Unresolved:', s.reason_unknown())
```
The direct concrete checks validate the arithmetic interpretation, not only the solver's own expression objects. The example yields 27 if Z3 is available.

## Guard against a wrong model
Write one positive and one rejecting concrete input when available. Check that both agree with the program before trusting a larger solve. An unconstrained variable can receive an arbitrary model value; model completion does not prove that all inputs were constrained. Inspect which predicates actually depend on each input.

Primary references: [Z3Py introduction](https://microsoft.github.io/z3guide/programming/Z3%20Python/Introduction/), [Z3 bit-vectors](https://microsoft.github.io/z3guide/docs/theories/Bitvectors/), [SymPy solvers](https://docs.sympy.org/latest/modules/solvers/solvers.html).
