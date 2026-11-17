# Resolve language semantics with a small executable experiment

Capture the language and package version from the provided runtime, lockfiles, image manifest, or application startup data. CLI and server configurations may differ; record settings that enable evaluation, templates, extensions, or buffering.

## Build the exact expression
For concatenated source, print the final expression using `repr`/JSON escaping and its length. Keep prefixes, suffixes, delimiters, and decoding order. For subprocesses, inspect the entire argument list rather than a shell-like string that was never passed to a shell.

Select three small tests: ordinary input, a discriminating input, and a control that should remain literal or be rejected. Use language-native execution, syntax checking, and stdout/stderr capture. Python `compile(text, '<probe>', 'eval')` checks expression syntax; it does not establish runtime names or side effects. `node --check file.js` similarly checks syntax, not application reachability.

## Interpret four separate results
1. Did parsing succeed?
2. Was the relevant operation actually reached?
3. What return value or exception followed?
4. What output or state change can be observed?

Short-circuiting, exception handlers, and buffering can separate those results. Use a deterministic marker or an in-memory state value inside the local probe; inspect stdout and stderr separately. Once local behavior is understood, send the corresponding application request and observe the target-specific effect.

## Choose the next action
A syntax failure calls for inspecting the exact composed expression. A missing symbol calls for restoring the minimal environment. A version mismatch calls for using matching local documentation or the provided runtime, and treating unmatched tests only as hypotheses. Repeating increasingly complicated expressions in the wrong interpreter adds little information.

Keep a successful probe short enough to re-run after editing the input. Extend it only for a dependency demonstrated by the code path.

Primary references: [Python builtins](https://docs.python.org/3/library/functions.html), [PHP manual](https://www.php.net/manual/en/), [Node.js CLI](https://nodejs.org/api/cli.html).
