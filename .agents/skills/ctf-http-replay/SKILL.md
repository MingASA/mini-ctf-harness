---
name: ctf-http-replay
description: Reproduce and compare HTTP requests with curl or Python requests, including cookies, encodings, redirects,
  and response bodies. Use when a browser request differs from a script, a payload is transformed in transit, or
  an HTTP result is ambiguous. Use ctf-web-discovery when the endpoint itself is unknown.
---

# HTTP Request Replay

Build a reproducible request, then compare the change that matters.

## Start
Capture one normal request before changing it. Preserve method, URL, headers, body bytes, cookies, and redirect handling. Use a new artifact prefix for each trial.

```bash
curl -sS --connect-timeout 3 --max-time 10 \
  -D baseline.headers -o baseline.body "$URL"
```

## Choose a reference
- Form/JSON/raw bodies, repeated parameters, path normalization, or Host/SNI: [request-fidelity.md](references/request-fidelity.md).
- Redirects, sessions, differential results, errors, or asynchronous effects: [response-comparison.md](references/response-comparison.md).

## Execute
1. Reproduce the normal response using curl or a `requests.Session`.
2. Change the request field under test while preserving the working transport and session setup. Keep required coupled fields, such as a nonce and its signature, consistent.
3. Save response status, headers, body, and transport errors separately. Inspect a small relevant body section, not an entire binary response.
4. Replay an interesting result and a control. Account for rotating tokens, timestamps, and session changes before attributing a difference to the tested input.

Continue the challenge with the exact working request. For a server-side parsing or execution question, follow the relevant source rather than repeatedly changing HTTP syntax.
