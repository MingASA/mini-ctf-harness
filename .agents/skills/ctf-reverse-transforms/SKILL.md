---
name: ctf-reverse-transforms
description: Reconstruct and invert byte or integer transformations from source, disassembly, or an encoder. Use
  for permutations, XOR/arithmetic encoders, rolling state, and short input validators. Use ctf-constraint-solving
  when coupled conditions are easier to solve than to invert; use ctf-binary-recon to locate an unknown validator
  first.
---

# Reverse Byte and Integer Transformations

Turn the actual forward computation into a verified inverse and preserve the recovered bytes.

## Start
Identify input length, element type, byte order, loop order, and the final comparison. Translate the smallest relevant routine to Python. Match one known input/output or an intermediate debugger observation before solving the inverse.

## Choose a reference
- Arithmetic width, signedness, permutations, or stateful loops: [semantics-and-inversion.md](references/semantics-and-inversion.md).
- A candidate needs checking, several inverses are possible, or decoded output looks plausible: [independent-checks.md](references/independent-checks.md).

## Solve
1. Separate decoding of the input representation from the transformation itself. Save raw inputs and intermediate bytes.
2. Reverse reversible operations in the opposite order. For an in-place update, determine which old and new values each step consumes before choosing a traversal direction.
3. Enumerate a small unknown parameter exactly. Use constraints for coupled unknowns rather than forcing an incorrect closed-form inverse.
4. Check the recovered candidate against the original forward routine, executable, or independently obtained observations. A round trip through two equally mistranslated routines is insufficient.
5. Write the candidate to a file and use those bytes in the final test; display text only as a convenience.

A useful result is a reproducer that transforms the recovered input into the required output, with any remaining ambiguity stated precisely.
