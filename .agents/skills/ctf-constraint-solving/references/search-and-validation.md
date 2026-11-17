# Search completion, solver outcomes, and candidate checks

## Make finite work explicit
Use a half-open range `[start, stop)` and log the next untested value after each completed chunk. Store the predicate/code version, input digest, bounds, elapsed time, and candidate results with the checkpoint. Resume only when the input and predicate still match; otherwise the old coverage does not apply.

A checkpoint records completed evaluations, not the intended final bound. Flush it after a completed chunk. For a multithreaded or split search, track completed intervals rather than reporting the largest scheduled index as coverage.

Distinguish these outcomes:
- The entire declared domain was checked with no candidate.
- The budget expired with a specific untested suffix.
- An exception interrupted an evaluation.
- A candidate was found and independently checked.

A failed assertion during setup establishes no search coverage. If enumeration is too large, exploit an actual constraint, meet-in-the-middle structure, or algebraic reduction before increasing the limit blindly.

## Interpret SMT results precisely
`unsat` means no solution to the encoded constraints, not no solution to the original problem. Recheck guessed bounds and width/signedness choices. `unknown` or a timeout is unresolved. Save `reason_unknown()` and the solver input for a targeted adjustment.

To enumerate alternatives, block the returned assignment of the relevant input variables, for example `s.add(Or(x != xv, y != yv))`, then solve again. Blocking an auxiliary variable alone can enumerate equivalent inputs. A second `unsat` after blocking establishes uniqueness only within the encoded domain and projection.

## Use concrete verification
Evaluate every original predicate on the candidate, including bounds, checksums, representation, and input length. Use exact arithmetic for an integer equality; a rounded root or a small floating-point residual is not sufficient. Save the candidate as bytes when the consumer expects bytes.

If the executable disagrees with the solver, inspect the first differing step or constraint. Keep the discovered candidate and diagnostic output rather than silently adding guessed format constraints until the result looks readable.

Primary references: [Z3 solvers and models](https://microsoft.github.io/z3guide/programming/Z3%20Python/Introduction/), [Python exact integer arithmetic](https://docs.python.org/3/library/stdtypes.html#numeric-types-int-float-complex).
