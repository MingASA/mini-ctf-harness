# Solver tools: choose an operation, then use the established implementation

Run commands through `run_command`; use `wait_job` for the returned job ID if a command is still running. Keep scripts, inputs, and results under `/work`. Older task containers retain their original image: check `command -v TOOL` or an actual import before concluding a tool is unavailable. This guide describes the current image.

| Question | Installed tools / entry point |
| --- | --- |
| What is this ELF and how is it mapped? | `file`, `readelf`, `checksec`, Python `pwn.ELF`, `elftools`, `lief` |
| Which functions, callers, references, and branches matter? | `r2`, `rizin`, `objdump`, `ctf-decompile` (Ghidra C export), `analyzeHeadless` |
| What happened at runtime? | `gdb`, `pwndbg`, `gdb-multiarch`, `strace`, `ltrace` |
| How do I assemble a reliable exploit? | Python `pwn` (ELF, ROP, cyclic, packing, process/remote), `ROPgadget`, `ropper` |
| Can I emulate or symbolically execute this code? | Python `capstone`, `unicorn`; `angr-python` for `angr`/`claripy`; QEMU user |
| Exact algebra, finite fields, lattices, constraints? | `sage`, `sage -python`, Python `sympy`, `z3` |
| Arrays, numerical transforms, plots? | Default `python3`: `numpy`, `scipy`, `matplotlib` (headless Agg; save plots to files) |
| Packet files or binary protocol fields? | Default `python3`: `scapy.all`; `tshark`, `tcpdump` |
| Known hash / password candidate testing? | `hashid`, `john`, `hashcat`, OpenSSL; verify the actual format first |
| Web requests, routes, SQL, source inspection? | `curl`, Python `requests`, `ffuf`, `sqlmap`, `semgrep`, `jq` |
| Endpoint / TCP stream? | `nmap`, `nc`, `socat`, Python `pwn` |
| Archive, metadata, hidden data? | `7z`, `unzip`, `binwalk`, `foremost`, `exiftool`, `pngcheck`, `steghide`, `zsteg`, `yara` |
| Documents, images, audio/video, memory/disk images? | `qpdf`, `pdftotext`, `oleid`, `olevba`, ImageMagick, FFmpeg, `vol` (Volatility 3), `fls`/`icat`/`mmls` |
| Android or Windows binary? | `jadx`, `apktool`, `wine`/`wine64`, MinGW |

## Binary analysis without a hand-written ELF parser

```sh
file ./program
checksec --file=./program
readelf -hW -lW -SW ./program > elf-layout.txt
r2 -q -e scr.color=0 -c 'aaa; afl; pdf @ sym.main' ./program > main.asm
# Inspect xrefs using an address actually reported by the analysis:
# r2 -q -e scr.color=0 -c 'aaa; axt @ ADDRESS' ./program
rizin -q -c 'aaa; afl; pdf @ sym.main' ./program > main-rizin.asm
ctf-decompile ./program main.c main
# Export multiple named functions in one analysis:
# ctf-decompile ./program selected.c main check_input
# A function address is also accepted. Omit selectors to export all functions.
```

`ctf-decompile` writes C pseudocode and `OUTPUT.ghidra.log`. Check its exit status and read the output file. It creates and cleans its own analysis project. Failed exports leave any previous output untouched, so do not treat an old file as a new success. Decompiled C is a reconstruction: confirm widths, signedness and critical branches in disassembly. `r2` disassembly and Ghidra C export are different operations; do not assume an optional r2 decompiler plugin is installed.

For structured ELF metadata:
```python
from elftools.elf.elffile import ELFFile
with open('program', 'rb') as stream:
    elf = ELFFile(stream)
    print(elf.header)
    for section in elf.iter_sections():
        print(section.name, section['sh_offset'], section['sh_size'])
```
Use `zipfile` for ZIP structure and Scapy for packets. Write a custom parser only for a demonstrated unsupported structure, and cross-check its fields with a mature reader before relying on it. Zero strides, absurd offsets, and repeated identical rows are parser failures to investigate immediately.

## Exploit construction and debugging

```python
from pwn import *
context.binary = elf = ELF('./program', checksec=False)
print(elf.checksec(), elf.symbols)
rop = ROP(elf)
print(rop.dump())
# Choose process('./program') or remote(host, port) from the supplied task.
# Synchronize with observed prompts using recvuntil/sendlineafter, not sleeps.
```

```sh
ROPgadget --binary ./program --only 'pop|ret'
ropper --file ./program --search 'pop rdi; ret'
# Save target input in input.bin and debugger commands separately.
gdb -q -batch -ex 'break main' -ex 'run < input.bin' -ex 'info registers' --args ./program
pwndbg -q -batch -ex 'break main' -ex 'run < input.bin' -ex 'telescope $sp 8' --args ./program
```

`pwndbg` is its own debugger command; plain `gdb` remains available. In pwntools set `context.gdb_binary = 'pwndbg'` when needed. A denied ASLR-disable request does not by itself mean debugging failed: inspect whether the program actually reached the breakpoint. Preserve current-process addresses and account for ASLR.

## Python environments and mathematical tools

- `python3 script.py`: pwntools, pyelftools, LIEF, Capstone, Unicorn, Scapy, NumPy, SciPy, Matplotlib, SymPy, Z3, PyCryptodome, cryptography, Pillow, requests.
- `angr-python script.py`: isolated angr and claripy environment. Use this interpreter for symbolic execution; its Z3/Capstone versions are independent of default Python. Locate actual find/avoid addresses first, constrain the input model, and replay every found candidate on the original binary.
- `sage solve.sage`: Sage syntax, finite fields, polynomials and lattice operations. `sage -python solve.py` supports `from sage.all import ...`. Plain `python3` does not import Sage.

```sh
angr-python -c 'import angr; p=angr.Project("./program", auto_load_libs=False); print(p.loader.main_object.entry)'
sage -c 'print(GF(101)(7)^(-1)); print(matrix(ZZ, [[1,2],[3,5]]).LLL())'
python3 - <<'PY'
import numpy as np
from scipy import signal
import matplotlib.pyplot as plt
x = np.arange(64)
y = np.sin(2*np.pi*x/8)
print(np.abs(np.fft.rfft(y)).argmax())
plt.plot(x, y); plt.savefig('signal.png')
PY
```

## Scapy and password tools

```python
from scapy.all import PcapReader, IP, TCP, Raw
with PcapReader('capture.pcap') as packets:
    for packet in packets:
        if IP in packet and TCP in packet:
            print(packet[IP].src, packet[TCP].dport)
            if Raw in packet:
                print(bytes(packet[Raw]))
```

Scapy can read/write PCAPs and construct packets without raw-socket privileges. Live sniffing or raw transmission additionally depends on the task's network and capabilities. Use ordinary sockets/pwntools for TCP services when raw operations are unavailable.

```sh
hashcat --identify hashes.txt
hashcat -m 0 -a 0 -D 1 --potfile-path /work/hashcat.pot hashes.txt words.txt
# -m 0 is raw MD5 only; select the mode from actual evidence.
john --wordlist=words.txt --session=/work/john-session hashes.txt
john --show hashes.txt
```

Hashcat has a CPU OpenCL backend in the solver. The inference GPU is not passed into the task container. Debian John supports its packaged formats; do not assume Jumbo-only helpers or formats exist.

## When an attempt fails

Read the matched skill before implementing an unfamiliar workflow. After two similar failures, record the error and change the method: raw disassembly to xrefs/decompilation; guessed offsets to GDB plus cyclic; manual metadata decoding to pyelftools; ad hoc process I/O to pwntools. Distinguish tool invocation errors from evidence about the challenge. Inspect exit status and stderr before trusting partial stdout. With shell pipefail, `producer | head` can stop an `&&` chain with SIGPIPE; save output first and read a slice separately.

Keep searches scoped to supplied artifacts and evidence-backed locations. If an endpoint or flag-bearing service is missing, demonstrate that dependency and ask the operator; searching the whole tool image or guessing network endpoints does not supply the missing challenge service. Offline knowledge is for general facts, not challenge-name writeups.
