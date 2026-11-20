# Packet captures and Scapy

Use `tshark -r capture.pcap -q -z conv,tcp` to identify conversations, then select a relevant stream. Scapy is installed in default `python3`; use its protocol layers instead of manually guessing PCAP or IP header offsets.

```python
from scapy.all import PcapReader, PcapWriter, IP, TCP, Raw
with PcapReader('capture.pcap') as packets, PcapWriter('selected.pcap', sync=True) as output:
    for packet in packets:
        if IP in packet and TCP in packet and packet[TCP].dport == 12345:
            output.write(packet)
            if Raw in packet:
                print(packet.time, packet[IP].src, bytes(packet[Raw]))
```

Choose the port from observed conversations. Packet payloads are not automatically a reassembled TCP stream: account for sequence numbers, retransmissions and direction, or use tshark's stream reassembly. Preserve original packet numbers and timestamps.

Packet construction and PCAP read/write work without raw-socket privileges. Live sniffing and raw sending depend on the configured task network/capabilities. Use ordinary TCP sockets or pwntools for a stream service when raw access is unavailable; do not infer that Scapy is missing from a permissions error.
