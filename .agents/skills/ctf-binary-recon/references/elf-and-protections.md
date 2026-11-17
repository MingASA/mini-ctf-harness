# ELF properties and addresses

## Read what controls loading
`readelf -hW` provides class, endianness, machine, type, and entry point. `-lW` describes segments and the interpreter; `-dW` shows dynamic dependencies and binding flags. Program segments, not section names alone, determine mapped permissions.

Use pwntools when available:
```python
from pwn import ELF
elf = ELF('./program', checksec=False)
print(elf.arch, elf.bits, elf.endian)
print(elf.checksec())
```
Check the interpreter and dependency paths when an existing executable reports that it cannot be launched. A missing loader can produce an apparent file-not-found error. Prefer static dependency metadata before executing helper tools that may invoke a target loader.

## Interpret protections as constraints
| Property | What it changes |
|---|---|
| NX / non-executable mappings | Data bytes are not automatically executable |
| PIE | Image-relative addresses need a runtime load bias |
| ASLR | Runtime mappings can differ between process instances |
| Canary indication | Some functions may be protected; inspect the vulnerable function |
| Full RELRO | Relocation-related pages, including the usual GOT, become read-only |
| CET metadata | Indicates features; actual enforcement also depends on platform/runtime |

A checksec summary is not proof of a specific vulnerability or exploit strategy. A missing imported canary routine is also not a complete audit of every custom protection.

## Keep address domains separate
File offset, image virtual address, and runtime address are different quantities. Within a PT_LOAD segment, file bytes at offset `f` correspond to `p_vaddr + (f - p_offset)` when the offset is inside the file-backed range. Add the runtime load bias to obtain the live address. The zero-filled region beyond `p_filesz` has no corresponding file bytes.

For PIE, derive load bias from mappings and matching segment/file offsets, or let the debugger/ELF loader resolve symbols. An address obtained from one run belongs to that run until shown otherwise. Rebase symbols once; avoid manually adding a base to a pwntools address that was already rebased through `elf.address`.

Primary references: [GNU readelf](https://sourceware.org/binutils/docs/binutils/readelf.html), [pwntools ELF](https://docs.pwntools.com/en/stable/elf/elf.html).
