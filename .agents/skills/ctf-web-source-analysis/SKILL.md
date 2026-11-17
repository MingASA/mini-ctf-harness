---
name: ctf-web-source-analysis
description: Trace web inputs through JavaScript, routes, middleware, and server-side sinks to construct a working
  test. Use for supplied web source, minified request builders, template or command evaluation, and parser/version-dependent
  behavior. For an established SQL injection point use ctf-sql-injection.
---

# Web Source and Runtime Analysis

Follow the code that handles the useful input, then test its actual semantics.

## Start
Find the route or request builder related to the observed behavior. Search for the endpoint, distinctive response text, or operation name before reading whole bundles.

```bash
rg -n 'fetch\(|axios|XMLHttpRequest|WebSocket|router\.|app\.' "$SOURCE_DIR"
```

## Choose a reference
- Browser code hides parameters, tokens, or request construction: [client-request-tracing.md](references/client-request-tracing.md).
- Server parsing, middleware, validation, and sinks determine exploitability: [source-to-sink.md](references/source-to-sink.md).
- A language expression, template, or subprocess behaves unexpectedly: [runtime-experiments.md](references/runtime-experiments.md).

## Follow the relevant slice
1. Map input source, decoding, transformations, validation, sink, and returned or stored effect. Include reachable helper functions and configuration that change those steps.
2. Identify the exact condition a useful input must satisfy or evade. Build the smallest input that distinguishes the proposed mechanism from ordinary data handling.
3. Reconstruct composed strings and argument vectors as bytes or escaped text. Use the target's known runtime version for a local semantic experiment when available.
4. Replay through the application and inspect the intended effect. Use successful local tests to predict target behavior, then verify the prediction.

Keep only the relevant code slice, the constructed input, and the observed effect. Continue exploiting the confirmed mechanism rather than deobfuscating unrelated code.
