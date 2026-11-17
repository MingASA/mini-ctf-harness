# Preserve the request that reaches the server

## Choose the representation deliberately
`curl --data-urlencode 'key=value'` creates form data with encoding. `--data-binary @body.bin` sends the file contents as the body. Set the intended `Content-Type`; exact body bytes alone do not select a parser. `-F 'upload=@sample.bin'` generates multipart boundaries correctly. Avoid copying a browser's multipart Content-Type while generating a different body.

For query parameters, `curl -G --data-urlencode 'term=a+b' "$URL"` sends a literal plus inside the parameter value. With requests, `params` and `data` encode values; `json` serializes JSON. Pre-encoding a value and then passing it to an encoding helper can add an extra decoding layer.

Repeated parameters and order can matter. Use a list of pairs, not a dict that loses duplicates:
```python
import requests
s = requests.Session()
req = requests.Request('POST', 'http://service.test/query',
                       data=[('item', 'first'), ('item', 'second')])
p = s.prepare_request(req)
print(p.method, p.url, p.headers.get('Content-Type'), repr(p.body))
```
This inspects the prepared request without sending it. Use `Session.prepare_request`, not only `Request.prepare`, when session cookies and defaults must apply. For the actual send, preserve the environment settings that the normal request used, including its CA and proxy configuration.

## Distinguish routing fields
- The URL selects destination, scheme, and usually TLS SNI.
- HTTP Host/authority selects virtual-host routing.
- A proxy can normalize the path before the application sees it.
- `curl --path-as-is` preserves dot segments that curl would otherwise normalize; inspect the request trace to confirm the bytes actually emitted.
- Requests may normalize URLs. For a parser experiment requiring exact raw framing, use an existing HTTP inspection tool or a deliberate raw request, rather than assuming a high-level client is byte-transparent.

## Save useful evidence
Use `--trace-ascii trace.txt` for readable request inspection, or `--trace trace.txt` for a byte-oriented trace. Traces include cookies and bodies; keep them with the task artifacts. If transmission is correct and the result is still surprising, inspect server parsing, middleware, or application state next.

Primary references: [curl manual](https://curl.se/docs/manpage.html), [Requests advanced usage](https://requests.readthedocs.io/en/latest/user/advanced/).
