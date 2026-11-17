# Establish format control and the argument layout

`printf(input)` and `printf("%s", input)` treat the same bytes differently. The former can interpret format directives; the latter prints data. Logging APIs, fortified wrappers, wide-character functions, and language formatting libraries need their own semantics.

## Locate controlled arguments
Use a recognizable marker and a bounded number of pointer/integer directives. Positional forms such as `%k$p` are supported by common POSIX implementations but are not universal across all C runtimes. Check whether the input parser transforms percent signs or truncates at whitespace/NUL before the formatting call.

On x86-64, variadic arguments may originate in register-save areas before stack slots. An offset is not simply the count of stack words from a guessed buffer address. Measure it against the actual call, alignment, and surrounding format text. Avoid assuming an offset from another run, binary, or tutorial.

Pwntools `FmtStr` can discover offsets when its callback returns the real output of one complete exchange. Ensure the callback starts from a consistent state and returns bytes from the correct output channel. For a stateful remote service, several discovery probes can affect the state; use a local equivalent when available and confirm the resulting position remotely.

## Turn a leak into a read
A `%p` leak reports a value. `%s` dereferences a pointer and reads until NUL, which can fault or overread. Use a precision bound where supported and ensure the pointer is readable. A marker delimiter can itself occur inside leaked bytes; use known lengths or an unambiguous framing strategy when possible.

Identify whether a leaked address belongs to the executable, stack, heap, or a library using mappings or independent offsets. Keep the leak's process identity. Reconnecting may invalidate it.

Primary references: [pwntools fmtstr](https://docs.pwntools.com/en/stable/fmtstr.html), [printf semantics](https://man7.org/linux/man-pages/man3/printf.3.html).
