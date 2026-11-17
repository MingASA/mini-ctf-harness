---
name: ctf-network-recon
description: Discover reachable ports and identify services with Nmap, then verify the endpoint with a protocol
  client. Use for a supplied host with unknown services, an unrecognized listening port, or a failed connection.
  For paths or virtual hosts on an already working HTTP service, use ctf-web-discovery.
---

# Network Service Discovery

Turn the supplied host or endpoint into a short, verified service map.

## Start
Use an already supplied port first. Otherwise choose a bounded port set from the task or an initial Nmap top-port scan. Record the host, network namespace, port set, and scan completion. Keep machine-readable output on disk.

```bash
# Set TARGET and PORTS from the task, for example a hostname and comma-separated ports.
nmap -sT -n -sV --version-light --reason -p "$PORTS" \
  --host-timeout 60s -oA services "$TARGET"
```

## Choose a reference
- Port selection, scan completion, or `open|filtered` results: [ports-and-coverage.md](references/ports-and-coverage.md).
- An open port speaks an unexpected protocol, TLS fails, or container networking differs: [service-confirmation.md](references/service-confirmation.md).

## Work the result
1. Select one plausible open service and make one protocol-correct request. Treat a banner as a lead, not a vulnerability.
2. Separate DNS, connection, TLS, and application failures. Repair the layer that actually failed.
3. Expand the port range only when the first completed scan or task evidence warrants it. Reuse the saved scan rather than restarting discovery after every new idea.
4. Continue with the verified endpoint: HTTP replay/discovery for a web service, or pwntools for a binary protocol.

Retain the endpoint, observed protocol, request needed to reach it, and any uncompleted scan range. A partial scan is useful evidence; label its coverage accurately.
