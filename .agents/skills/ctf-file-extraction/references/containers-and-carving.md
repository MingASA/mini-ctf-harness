# Archives, compression, and embedded-file boundaries

## List before extraction
`file` recognizes signatures, not the full structure. Verify a candidate format with its normal reader. A suffix can be misleading; a valid outer format can contain another file.

| Format | List or inspect | Extract selected content |
|---|---|---|
| ZIP | `unzip -l archive.zip` | `unzip -p archive.zip 'member' > member.bin` |
| tar | `tar -tf archive.tar` | `tar -xOf archive.tar -- 'member' > member.bin` |
| 7-Zip supported formats | `7z l archive.bin` | Use `7z x` with a fresh output directory |
| cpio | `cpio -it < archive.cpio` | Use cpio in a fresh output directory |
| gzip | `gzip -l data.gz` | `gzip -dc data.gz > layer.bin` |

Quoted member names can still be patterns in some tools. Inspect the listing and choose a library reader when exact member identity matters. Handle multiple members, symlinks, and absolute or parent-relative paths deliberately; extracting into a new folder alone does not constrain every archive entry. Preserve the original and the selected member name.

Use Python `zipfile` or `tarfile` for programmatic member listing and selected-member reads. Prefer reading member bytes directly over recreating an entire filesystem when only one object is needed. Avoid implementing a new archive parser when an installed mature reader already supports the format.

## Carve with structural evidence
Binwalk or a signature search can propose embedded offsets, but random bytes can match magic values. Inspect the offset, expected length, and a format-aware parser before accepting a carved object. Consult the installed Binwalk version's help; extraction interfaces and dependencies differ across versions.

Use a bounded byte range when length is known:
```bash
# OFFSET and LENGTH come from the parsed structure, in decimal bytes.
dd if="$INPUT" of=carved.bin bs=1 skip="$OFFSET" count="$LENGTH" status=none
file -- carved.bin
```
A byte-at-a-time carve is adequate for a small region, not an efficient plan for multi-gigabyte disks. Verify output length and parser success. A decompressor can stop at a member boundary while trailing data remains; examine unused bytes only when structure or task evidence warrants it.

## Bound recursive expansion
After each layer, record compressed and extracted sizes. Set a disk/time budget before unpacking many layers. Repeatedly extracting identical content adds no information; compare hashes when a container appears to loop.

Primary references: [Python zipfile](https://docs.python.org/3/library/zipfile.html), [Python tarfile](https://docs.python.org/3/library/tarfile.html), [GNU tar](https://www.gnu.org/software/tar/manual/tar.html).
