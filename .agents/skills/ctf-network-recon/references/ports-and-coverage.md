# Ports, scan states, and coverage

## Pick the least expensive informative scan
Nmap `-sT` uses ordinary TCP connections and works without raw-socket privileges. For a known endpoint, `-p "$PORT"` is more useful than a broad discovery sweep. For an unknown service on a specified host, start with `--top-ports 100`; expand to a relevant range or `-p-` when needed. Scan UDP separately when the task gives a UDP clue; TCP results say nothing about UDP listeners.

Host discovery can reject a reachable host when probes are filtered. If another tool already reached that host, repeat the relevant scan with `-Pn`. This skips discovery; it does not bypass filtering. `-n` avoids reverse-DNS delays, while a hostname still needs forward resolution.

Save `-oA scan-name`. The XML records ports, states, service attributes, and completion metadata. With an outer timeout, retain its exit status and check whether XML is complete before claiming coverage. A host timeout is not proof that every requested port is closed.

## Interpret states
| Observation | Supported conclusion | Useful next step |
|---|---|---|
| TCP `open` | A listener accepted the probe | Send a protocol-correct request |
| `closed` | A response indicates no listener at that endpoint | Recheck the supplied port or service startup |
| `filtered` | Probes cannot decide reachability of the port | Check the route, namespace, and probe type |
| UDP `open|filtered` | No decisive reply | Use a small protocol-specific query |
| Missing ports after interruption | Coverage is incomplete | Resume only the missing work |

A service label based only on a conventional port number is weaker than a successful protocol exchange. A version banner can be modified; verify any version-dependent behavior separately.

## Read results without a wall of text
```python
import xml.etree.ElementTree as ET
root = ET.parse('services.xml').getroot()
for host in root.findall('host'):
    address = host.find('address')
    for port in host.findall('./ports/port'):
        state = port.find('state')
        if state is not None and state.get('state') in {'open', 'open|filtered'}:
            service = port.find('service')
            print(address.get('addr') if address is not None else '?',
                  port.get('protocol'), port.get('portid'), state.get('state'),
                  service.attrib if service is not None else {})
```
If parsing fails, inspect the saved stderr and XML tail. Keep the malformed output as a partial result rather than silently replacing it with an empty service list.

Primary reference: [Nmap port states](https://nmap.org/book/man-port-scanning-basics.html).
