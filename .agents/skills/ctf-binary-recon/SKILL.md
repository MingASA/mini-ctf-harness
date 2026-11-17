---
name: ctf-binary-recon
description: Identify a native binary, map its input/checking logic, and choose a reversing or exploitation path
  with file, readelf, objdump, and optional Ghidra. Use for an unfamiliar ELF, stripped executable, missing symbols,
  or unclear protections. For a known crashing instruction or live registers use ctf-gdb-debugging.
---

# Native Binary Reconnaissance

Produce a useful map of the binary before investing in a particular exploit or solver.

## Start
```bash
file ./program
readelf -hW -lW -dW ./program > elf-layout.txt
readelf -sW ./program > symbols.txt
strings -a -t x ./program > strings.txt
```
Inspect architecture, endianness, ELF type, interpreter, dependencies, and relevant strings. Use `objdump -d` on the selected region rather than putting the entire executable into context.

## Choose a reference
- Architecture, segments, symbols, protections, or static/runtime addresses: [elf-and-protections.md](references/elf-and-protections.md).
- Finding input handlers and checks, using a decompiler, or reducing an unfamiliar program: [code-slicing.md](references/code-slicing.md).

## Build the map
1. Locate the input channel and the code that decides acceptance or processes input. Use strings, imports, cross-references, and callers.
2. Identify the relevant constraint or primitive: comparison, transform, bounds error, format-string use, or another reachable operation.
3. Mark which facts come from metadata, disassembly, decompilation, or a run. Check critical types and branches against instructions.
4. Take the shortest next step: debugger for live values, transform/constraint solving for a checker, or a focused exploitation skill for an established primitive.

Retain function locations, input contract, relevant data, and the next executable experiment. A binary-wide listing is an artifact to search, not a required reading assignment.
