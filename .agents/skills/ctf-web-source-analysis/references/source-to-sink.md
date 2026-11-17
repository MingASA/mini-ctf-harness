# Reconstruct a reachable input-to-operation path

Write the short path that matters: request field -> parser -> transformation -> check -> operation -> observable result. Resolve helpers on that path, not every helper in the repository. Determine how the route is registered and which middleware runs first. Configuration, alternate methods, and earlier route matches can change reachability.

## Classify the operation before choosing syntax
| Sink | Question that changes the test |
|---|---|
| SQL execution | Is input bound as a value or inserted into SQL text? |
| Template rendering | Is input template source or a value in a fixed template? |
| Subprocess | Is there a shell, or an argument vector passed directly to a program? |
| File open/include | Is input a path, an identifier lookup, or executable content? |
| Object update | Which fields are client-controlled and which are server-assigned? |
| URL fetch | Which parser, redirect policy, and destination checks apply? |

A function name is not proof of a vulnerability. Check the data flow and the semantics of its arguments. A parameterized value does not become SQL syntax, but separately interpolated identifiers still need analysis. A shell-free argument vector prevents shell metacharacter interpretation; the invoked program may still treat an attacker-controlled argument as an option or special operand.

## Derive a useful experiment
Choose a non-destructive, distinctive result that the proposed mechanism predicts and normal data handling does not. Keep wrappers and validation conditions exactly as the source constructs them. Verify where decoding occurs; checking an encoded form and using a decoded form are different operations.

Inspect the application effect after the sink. A serialized response may hide a database change; a caught exception may hide earlier processing. Conversely, reflected input or an error naming the operation is not proof it completed.

## Use framework behavior precisely
Templates can escape HTML while still evaluating template syntax when attacker text becomes template source. ORM methods can parameterize values while raw fragments interpolate SQL. Defaults depend on the selected API and configuration. Read the installed package/source or matching local documentation when that distinction determines the route.

Primary references: [PortSwigger server-side template injection](https://portswigger.net/web-security/server-side-template-injection), [Python subprocess](https://docs.python.org/3/library/subprocess.html).
