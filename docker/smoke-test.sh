#!/bin/sh
# Run inside the solver image with writable /tmp, including under the sandbox.
set -eu

for tool in 7z aapt analyzeHeadless apktool base64 bash binwalk bzip2 checksec cpio curl dig exiftool ffmpeg ffprobe file fls \
    foremost g++ gcc gdb gdb-multiarch git gzip hashid hexdump identify ip jadx jq ltrace make \
    nasm nc ncat netcat nmap nm nslookup objdump openssl patchelf pdfdetach \
    oleid olevba pdfinfo pdftotext pip pip3 pngcheck python python3 qemu-x86_64 qpdf r2 readelf rg smali socat \
    sqlite3 ss steghide strace strings tar tcpdump tshark unrar unzip wget xxd \
    vol wine wine64 i686-w64-mingw32-gcc x86_64-w64-mingw32-gcc xz yara zip zstd zsteg; do
    command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
    printf '%s: %s\n' "$tool" "$(command -v "$tool")"
done

python3 -c 'import capstone, Crypto, cryptography, elftools, paramiko, PIL, pwn, requests, sympy, unicorn, z3, zstandard'
cpio --version | head -n 1
7z | sed -n '2p'
binwalk --help >/dev/null
exiftool -ver
gdb --version | head -n 1
nmap --version | head -n 1
openssl version

test_dir=$(mktemp -d /tmp/ctf-smoke.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
cd "$test_dir"
printf 'ctf-smoke\n' > original
printf 'A' | hexdump -e '1/1 "%02x"' | grep -qx 41
hashid 5d41402abc4b2a76b9719d911017c592 | grep -qi md5
printf 'rule smoke { strings: $a = "ctf-smoke" condition: $a }\n' > smoke.yar
yara smoke.yar original | grep -q '^smoke '
python3 - <<'PY'
from PIL import Image
import random
Image.new('RGB', (2, 3), 'white').save('sample.png')
random_bytes = random.Random(42).randbytes(128 * 128 * 3)
Image.frombytes('RGB', (128, 128), random_bytes).save('cover.jpg', quality=90)
objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
           b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
           b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
           b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
stream = b'BT /F1 12 Tf 72 720 Td (CTF smoke) Tj ET'
objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(b'%d 0 obj\n' % index + obj + b'\nendobj\n')
xref = len(pdf); pdf.extend(b'xref\n0 %d\n0000000000 65535 f \n' % len(offsets))
for offset in offsets[1:]: pdf.extend(b'%010d 00000 n \n' % offset)
pdf.extend(b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(offsets), xref))
open('sample.pdf', 'wb').write(pdf)
PY
[ "$(identify -format '%wx%h' sample.png)" = 2x3 ]
zsteg sample.png >/dev/null
printf 'hidden test data\n' > hidden.txt
steghide embed -cf cover.jpg -ef hidden.txt -sf hidden.jpg -p testpass >/dev/null 2>&1
steghide extract -sf hidden.jpg -xf recovered.txt -p testpass >/dev/null 2>&1
cmp hidden.txt recovered.txt
qpdf --check sample.pdf >/dev/null
pdftotext sample.pdf - | grep -q 'CTF smoke'
pdfdetach -list sample.pdf >/dev/null
ffmpeg -v error -f lavfi -i sine=frequency=1000:duration=0.1 sample.wav
ffprobe -v error -show_entries format=format_name -of default=nw=1:nk=1 sample.wav | grep -qx wav
apktool --version
mkdir smali
cat > smali/Hello.smali <<'SMALI'
.class public LHello;
.super Ljava/lang/Object;
.method public static value()I
    .registers 1
    const/4 v0, 0x1
    return v0
.end method
SMALI
smali assemble smali -o classes.dex
jadx -q -d jadx-out classes.dex
grep -Rq 'class Hello' jadx-out/sources
cat > AndroidManifest.xml <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="test.ctf.smoke"><application android:label="Smoke" /></manifest>
XML
aapt package -f -M AndroidManifest.xml -I /usr/share/android-framework-res/framework-res.apk -F sample.apk
zip -q sample.apk classes.dex
apktool d -f -o apk-output sample.apk >/dev/null
grep -q 'test.ctf.smoke' apk-output/AndroidManifest.xml
python3 - <<'PY'
from zipfile import ZipFile
with ZipFile('sample.docx', 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>smoke</w:t></w:r></w:p></w:body></w:document>')
PY
olevba sample.docx | grep -qi 'No VBA or XLM macros found'
cat > sample.c <<'C'
#include <stdio.h>
int main(void) { puts("PE execution OK"); return 0; }
C
i686-w64-mingw32-gcc -o sample32.exe sample.c
x86_64-w64-mingw32-gcc -o sample64.exe sample.c
wine64 sample64.exe | grep -q 'PE execution OK'
wine sample32.exe | grep -q 'PE execution OK'
wineserver -w
gcc -o sample.elf sample.c
qemu-x86_64 sample.elf | grep -q 'PE execution OK'
r2 -qc ij sample.elf | python3 -c 'import json,sys; assert json.load(sys.stdin)["bin"]["bintype"] == "elf"'
gdb-multiarch -batch -ex 'file sample.elf' -ex 'info files' | grep -q 'elf64'
truncate -s 8M sample.ext4
mkfs.ext4 -q -F sample.ext4
fls sample.ext4 | grep -q 'lost+found'
vol --offline -f original banners.Banners > volatility.log
mkdir ghidra-project
if ! analyzeHeadless "$test_dir/ghidra-project" smoke -import "$test_dir/sample.elf" \
    -analysisTimeoutPerFile 120 -max-cpu 1 -deleteProject > ghidra.log 2>&1; then
    cat ghidra.log >&2; exit 1
fi
grep -q 'REPORT: Import succeeded' ghidra.log || { cat ghidra.log >&2; exit 1; }
printf 'original\n' | cpio -o -H newc > sample.cpio 2>/dev/null
mkdir extracted
(cd extracted && cpio -i < ../sample.cpio 2>/dev/null)
cmp original extracted/original
7z a sample.7z original >/dev/null
7z t sample.7z >/dev/null
for compressor in bzip2 xz zstd; do
    "$compressor" -c original > sample.compressed
    "$compressor" -dc sample.compressed > decoded
    cmp original decoded
done
echo 'Solver image smoke test passed.'
