# Find the code that matters

Start from a stable anchor: a prompt, accepted/rejected string, imported parser, or known output. Use the anchor to locate its references, then follow the relevant caller and data dependencies. Keep original offsets and symbols when assigning descriptive names.

## Lightweight CLI path
```bash
objdump -d -M intel ./program > disassembly.txt
rg -n 'strcmp|memcmp|scanf|read@|fgets|printf@' disassembly.txt
```
These imports are leads, not mandatory features; static, stripped, inlined, or non-C code may have none. Once a function is identified, use `objdump --disassemble=FUNCTION` for a symbol or `--start-address`/`--stop-address` for a known image range.

A string's `strings -t x` offset is a file offset. Convert it using the relevant segment before treating it as an address. On a stripped binary, locate code references with a disassembler/decompiler, then use dynamic observations to confirm the path.

## Ghidra when available
Import with the correct processor and compiler convention, run analysis once, and inspect cross-references to the selected anchor. Focus on that function and its direct data dependencies. Check signed comparisons, variable widths, loop updates, and indirect calls against the disassembly; decompiled C is a reconstruction.

For a headless installation:
```bash
"$GHIDRA_HOME/support/analyzeHeadless" "$PROJECT_DIR" triage \
  -import "$BINARY" -analysisTimeoutPerFile 60
```
Create PROJECT_DIR first and use a fresh project name or the appropriate existing-project options. Headless analysis creates/updates a project; it does not automatically export C pseudocode. Use an installed, documented Ghidra export script when available and confirm its output path rather than assuming a wrapper exists.

## Choose the next operation
For a short deterministic checker, recover the forward function and data. For ambiguous runtime state, observe one call or branch under GDB. For a reachable overwrite, record its object, extent, and input restrictions before building a payload. This prevents decompiling unrelated startup code from becoming the main task.

Primary references: [GNU objdump](https://sourceware.org/binutils/docs/binutils/objdump.html), [Ghidra](https://github.com/NationalSecurityAgency/ghidra).
