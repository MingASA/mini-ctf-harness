# Keep interaction phases synchronized

Model a small set of concrete phases: menu, input, response, leak, next input. Record which bytes end the current phase. Read exactly that boundary instead of relying on a fixed sleep and a large catch-all receive.

## Local and remote launch
```python
from pwn import process, remote
# Select one using the task's actual endpoint and argv.
# io = process(['./program'])
# io = remote(host, port, timeout=3)
```
For comparisons sensitive to buffering, choose the process's stdin/stdout handling explicitly. A PTY can cause different buffering from a pipe or socket. Distinguish stderr diagnostics from the data channel if the protocol does not combine them. Use `context.log_level='debug'` temporarily for a short exchange, then reduce logging after the framing is understood.

## Parse a leak as its actual representation
A textual hexadecimal address is parsed with an integer conversion after extracting the exact field. A raw address leak is bytes and needs the right endian/width. If a C string output stops at NUL, the truncated bytes are not automatically a complete address. Padding with zeros is justified only by a known leak construction and address representation.

`recvuntil` retains later bytes in the tube buffer. Consume that buffer normally; avoid adding another independent socket reader that competes with pwntools. A single receive may contain two protocol messages, or only part of one.

## Recover a failed phase
After a timeout, inspect the last complete phase, pending bytes, and whether the process is still alive. After EOF, capture the process return code or remote closure and decide whether replaying from the beginning is meaningful. A state-changing request may have succeeded before the connection ended; use a readback when available rather than automatically duplicating it.

For a local crash, preserve input bytes and switch to GDB. For a verified memory leak, preserve its connection/process context while constructing the dependent stage. For a final command or output request, receive a deterministic expected response instead of relying solely on `interactive()`.

Primary references: [pwntools process](https://docs.pwntools.com/en/stable/tubes/processes.html), [pwntools tubes](https://docs.pwntools.com/en/stable/tubes.html).
