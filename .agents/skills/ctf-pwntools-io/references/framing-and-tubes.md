# Select I/O operations from the protocol

| Protocol need | pwntools operation | Detail to check |
|---|---|---|
| Exact binary payload | `send(payload)` | Sends bytes without a delimiter |
| A line | `sendline(payload)` | Appends `tube.newline`, normally LF |
| Some available output | `recv(n, timeout=...)` | Up to n bytes, possibly fewer |
| Exactly n output bytes | `recvn(n, timeout=...)` | Test completion; timeout is not EOF |
| Output through an observed token | `recvuntil(token, timeout=...)` | Token must match actual bytes |
| Output through a newline | `recvline(timeout=...)` | Partial-line EOF handling has special behavior |
| End of input while keeping receive open | `shutdown('send')` | Appropriate only for EOF-delimited input |

The `sendafter`/`sendlineafter` helpers perform receive-then-send. A timeout in the receive stage can still be followed by the send. When the prompt is uncertain, separate the calls and test the received delimiter before transmitting.

## Treat timeout and closure differently
For many tube receive operations, a timeout returns `b''` and keeps incomplete data buffered. A true closed connection generally raises `EOFError` once the request cannot be satisfied; `recvline` may return an incomplete buffered line before EOF under its configured policy. Consult the installed API for that method rather than transferring raw socket semantics to every tube operation.

An explicit prompt gate:
```python
prompt = b'choice> '  # Replace with a token actually observed in the protocol.
try:
    chunk = io.recvuntil(prompt, timeout=2)
except EOFError:
    state = 'closed_before_prompt'
else:
    if chunk.endswith(prompt):
        io.sendline(b'1')
        state = 'sent_choice'
    else:
        state = 'prompt_timeout'
print(state)
```
This fragment uses an existing `io` tube. The token is a synthetic example, not a universal menu prompt.

## Preserve the bytes
Use bytes literals and `p32`/`p64` with the target architecture/endianness. Python `print()` adds text encoding and a newline; write payload files with `Path.write_bytes`. Avoid using `strip()` on binary leaks because it removes legitimate boundary bytes. `clean()` consumes buffered data; use it only when deliberately discarding that data.

Primary reference: [pwntools tubes](https://docs.pwntools.com/en/stable/tubes.html).
