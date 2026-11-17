---
name: ctf-web-file-access
description: Analyze and exploit web download, path traversal, local inclusion, and upload handling by tracing filename
  resolution and content processing. Use when request data selects or creates a server-side file. For extracting
  an archive already on disk use ctf-file-extraction.
---

# Web File Paths and Upload Handling

Determine how a request becomes a filesystem operation and which useful read, write, or processing behavior it exposes.

## Start
Reproduce one ordinary download or upload. Identify the input name, encoding, returned identifier, content type, and subsequent retrieval or processing endpoint. Read the associated route when available.

## Choose a reference
- Paths, canonicalization, traversal, file reads, or inclusion: [path-resolution.md](references/path-resolution.md).
- Multipart uploads, validation, storage names, retrieval, or processing: [upload-pipeline.md](references/upload-pipeline.md).

## Work the file pipeline
1. Map input decoding, path construction or ID lookup, validation, storage/open operation, and any later interpreter.
2. Test the relevant transformation using known application files or distinct synthetic content. Observe file bytes or processing behavior rather than relying on a filename reflection.
3. Separate a successful upload from storage, retrieval, and executable processing; each is a different capability.
4. Use the confirmed primitive to retrieve the task-relevant data or reach the intended operation.

Keep the exact request and response bytes, plus the observed storage/retrieval mapping. When an apparent path bypass fails, inspect the transformation or permissions actually responsible instead of guessing unrelated filenames.
