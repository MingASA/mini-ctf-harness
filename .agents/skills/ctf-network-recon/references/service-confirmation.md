# Confirm the service, not just the port

## Follow the connection layers
Resolve the supplied hostname with `getent ahosts "$HOST"`. Inspect the local route and listeners with `ip route` and `ss -lntup` when local service setup is involved. A container's loopback, the host loopback, and a remote machine are distinct network locations. Use the published address or the documented container network.

For HTTP, capture headers and a body independently:
```bash
curl -sS --connect-timeout 3 --max-time 8 \
  -D service.headers -o service.body "$URL"
```
An HTTP error status still establishes an HTTP response. A curl transport error does not establish application behavior. Follow a redirect only after inspecting its `Location` and deciding which endpoint it selects.

For TLS, use the hostname in the URL so both TLS SNI and HTTP routing receive it. To connect to a known address without changing that name:
```bash
curl --resolve "$HOST:$PORT:$IP" --connect-timeout 3 --max-time 8 \
  -D tls.headers -o tls.body "https://$HOST:$PORT/"
```
A `Host` header alone does not change SNI. For certificate and handshake inspection, use `openssl s_client -connect "$IP:$PORT" -servername "$HOST"` with an external deadline. Prefer the provided CA with `--cacert`; use `-k` to isolate a certificate-verification failure and record that difference from the normal request.

## Handle quiet protocols
A binary service may wait for input before sending anything. Use an observed message format or inspect the supplied binary before sending HTTP to an unknown protocol. `nc` flags differ between implementations; consult its local help rather than assuming every version supports `-N` or `-q`. Use pwntools when exact lengths, binary data, or multiple interaction phases matter.

## Resolve discrepancies
Compare scheme, address, port, Host/SNI, proxy settings, and network namespace before blaming the service. A successful connection from one namespace does not establish connectivity from another. Preserve successful endpoint parameters for subsequent tools.

Primary references: [curl manual](https://curl.se/docs/manpage.html), [Nmap service detection](https://nmap.org/book/man-version-detection.html).
