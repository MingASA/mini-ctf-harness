---
name: ctf-file-extraction
description: Identify and extract useful data from archives, documents, images, and embedded files using file, archive
  tools, ExifTool, and format-aware readers. Use for unknown blobs, nested containers, metadata, PDF objects, or
  text hidden by representation. Use ctf-binary-recon for executable logic and a packet-analysis workflow for PCAP
  streams.
---

# File Identification and Structured Extraction

Identify the real format and extract the smallest useful layer before choosing a deeper analysis.

## Start
Keep the original file intact and create a separate output directory. Record its size, type, and a short header preview.

```bash
file -- "$INPUT"
wc -c < "$INPUT"
xxd -l 96 "$INPUT"
```

## Choose a reference
- Compressed data, nested archives, or embedded-file offsets: [containers-and-carving.md](references/containers-and-carving.md).
- PDF text/objects, image metadata/channels, or a mismatch between visible and stored data: [documents-and-images.md](references/documents-and-images.md).

## Extract
1. Use a reader for the detected format. List entries or metadata before a bulk extraction.
2. Extract a relevant member or layer to a named artifact. Preserve its parent, offset/member name, and parser result.
3. Inspect the extracted format again. Let headers, structure, and task clues choose the next operation rather than running every available tool.
4. Search text outputs by relevant field or pattern and read a small surrounding range. Keep binary payloads in files.
5. Validate interesting data against its container structure and the task's acceptance condition. Distinguish a parser error from an empty valid result.

If a format-specific program is unavailable, use an already installed equivalent or a standard library reader for that format. A missing extractor is an environment issue, not evidence that the file contains no data.
