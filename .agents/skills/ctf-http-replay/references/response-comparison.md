# Compare outcomes without flattening them into status codes

## Separate transport from application results
Record a connection/DNS/TLS exception as a transport result. Record an actual HTTP response with its status and bytes, including 4xx/5xx. `raise_for_status()` can be useful in ordinary client code but should not discard an error body during an experiment.

Curl does not follow redirects without `-L`; requests normally follows redirects for GET and many other methods. Set redirect behavior explicitly. A final login page can hide an earlier redirect or cookie change. Inspect the chain and replay the decisive hop. Redirects can also change methods, so record the method at each hop.

Use a persistent session for a workflow, and separate sessions for separate identities. A response may rotate a cookie or CSRF token: capture the newly issued value before the next step.

## Choose the evidence channel
| Question | Stronger observation than a generic 200 |
|---|---|
| Did the parser accept a field? | A specific changed field in the returned object |
| Was a write committed? | A later read of the same object |
| Was a job merely accepted? | Its completion state and result endpoint |
| Did a template evaluate input? | A controlled evaluated result with a literal control |
| Did authorization change? | The protected operation succeeds under that identity |

A status code is one observation, not a substitute for the relevant effect. An empty body may be a valid no-content response. Compression, streaming, or buffering can change visibility without changing whether the server processed the request.

## A compact comparison
Keep status, Location, Set-Cookie, body length/hash, selected JSON fields, and elapsed time. Use raw body files as the authority; normalized text is only a comparison view. Retry a surprising result with a control. For timing-only signals, interleave controls and repeats, account for request variance, and avoid declaring a vulnerability from a single delay.

Synthetic example: a service returns 202 with a job identifier, while `/jobs/<id>` still says `queued`. That proves acceptance, not completed computation. The next useful request is the job status, not a different payload family.

Primary references: [Requests redirects](https://requests.readthedocs.io/en/latest/user/quickstart/#redirection-and-history), [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110).
