---
name: ctf-constraint-solving
description: Solve finite arithmetic and bit-vector constraints using Python, SymPy, or Z3, with exact candidate
  checks and resumable bounded searches. Use for coupled input checks, small unknown keys or states, modular equations,
  and overflow-sensitive predicates. Prefer ctf-reverse-transforms when a direct inverse is already clear.
---

# Exact Constraint and Bounded Search Solving

Choose the simplest exact method that fits the constraints, execute it, and check the candidate in the original computation.

## Choose a reference
- Decide between algebra, enumeration, and SMT; encode widths or signedness: [model-selection.md](references/model-selection.md).
- Manage search ranges, solver outcomes, multiple models, and verification: [search-and-validation.md](references/search-and-validation.md).

## Execute
1. Write down variables, domains, and the predicates supplied by the program or task. Keep inferred restrictions separate until tested.
2. Use algebra for a directly invertible equation, ordinary Python for a small finite domain, and Z3 for coupled bit-level predicates. SymPy is useful for exact symbolic arithmetic; floating-point guesses are not integer proofs.
3. Check the forward model on a small concrete case before running a large solve. Measure a small search chunk to estimate work.
4. Save the actual tested range or solver status. Resume unfinished work from a checkpoint instead of repeating the same prefix.
5. Re-evaluate a returned candidate through the original predicates using concrete values. Then run the actual program or protocol test when available.

Keep the runnable solver and raw candidate artifact. Finish the task when its acceptance condition is met; use another model only when the task needs alternatives or uniqueness.
