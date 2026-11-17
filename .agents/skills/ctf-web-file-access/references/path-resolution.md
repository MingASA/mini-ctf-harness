# Follow decoding and path resolution

Find whether the input is a filesystem path or a key into a server-side map. An object identifier need not be a path at all. Record decoding stages, separator rules, prefix/suffix concatenation, working directory, canonicalization, and the file API used. Path rules differ between operating systems and application libraries.

## Check the boundary the code really enforces
A textual prefix check does not establish directory containment. For example, `/srv/export-old/item` starts with `/srv/export` but is not inside that directory. Component-aware containment is the relevant relation. Resolving symlinks changes the actual path; a time-of-check/time-of-use race is a separate mechanism and requires its own evidence.

A pure lexical demonstration:
```python
from pathlib import PurePosixPath
base = PurePosixPath('/srv/export')
p = PurePosixPath('/srv/export-old/item')
assert str(p).startswith(str(base))
assert not p.is_relative_to(base)
```
This does not resolve symlinks or consult a live filesystem.

## Choose tests from the observed transformations
Use `curl --path-as-is` when client dot-segment normalization would hide the experiment. Use `--data-urlencode` for a query value when testing one encoding pass. A double-encoded input is meaningful only when there are two relevant decoding stages; blindly stacking encodings is not a diagnosis.

File reads, template loads, and language inclusion are different sinks. Reading source bytes does not execute them. A language wrapper is relevant only when the actual API supports it and configuration allows it. Analyze the selected API rather than assuming all filename consumers share behavior.

## Confirm a useful read
Compare retrieved bytes with a file whose content or structure is known. An error containing a resolved path can support a path model but is not file disclosure. Distinguish nonexistent paths, permission failures, and wrong handler selection. Preserve the working request's method, Host, and session for follow-up reads.

Primary references: [Python pathlib](https://docs.python.org/3/library/pathlib.html), [PortSwigger path traversal](https://portswigger.net/web-security/file-path-traversal).
