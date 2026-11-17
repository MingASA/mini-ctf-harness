# Extract the request instead of rebuilding the frontend

Search the endpoint, displayed error, form field, or request library call. Read a bounded region around the hit. Source maps, adjacent configuration, and route tables can reveal the same information more cheaply than renaming an entire minified bundle.

Record method, base URL, path construction, body encoding, headers, cookies, token source, and response parser. Distinguish values computed in the browser from values issued by the server. A disabled button or client-side validator is different from a server-enforced condition.

## Trace only the required dependencies
If a request uses a computed signature, trace its input bytes, ordering, key source, and time/nonce dependency. Preserve JSON field ordering or serialization rules when the signature covers the serialized body. Compare one known browser request with the reconstructed request before changing its signed fields.

Use local Node.js for a small extracted pure function. Preserve the observed inputs and runtime assumptions. A function requiring DOM state, a worker, WebCrypto, or a live browser may not behave in a plain Node process. Use an already available browser tool when that dependency is material; otherwise recover the network request rather than building a browser emulator.

WebSocket URLs are connection entry points, not a complete protocol description. Inspect message handlers for JSON message types, sequence numbers, authentication, and expected acknowledgments. Use a mature WebSocket client for that protocol rather than hand-encoding frames.

## When obfuscation matters
Resolve a string table or wrapper only until the relevant request and validation logic are visible. If evaluation has side effects, inspect the initializer before executing it. For large bundles, format a copy and search it, keeping the original bytes unchanged for replay or hashing.

Synthetic distinction: a script disables a `preview` button until a checkbox is selected, while the server route independently checks a signed token. Removing the UI check changes browser behavior, not the server's token requirement.

Primary references: [Node.js documentation](https://nodejs.org/api/), [Requests sessions](https://requests.readthedocs.io/en/latest/user/advanced/).
