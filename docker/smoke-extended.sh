#!/bin/sh
# Functional checks under the same non-root, read-only sandbox as a real task.
set -eu
for tool in rizin pwndbg sage john hashcat ropper angr-python ctf-decompile; do
    command -v "$tool" >/dev/null
done
test_dir=$(mktemp -d /work/extended-smoke.XXXXXX)
trap 'result=$?; if [ "$result" -eq 0 ]; then rm -rf "$test_dir"; else echo "Smoke artifacts: $test_dir" >&2; fi' EXIT
export HOME="$test_dir" XDG_CACHE_HOME="$test_dir/cache" DOT_SAGE="$test_dir/sage" MPLCONFIGDIR="$test_dir/matplotlib"
cd "$test_dir"
cat > fixture.c <<'C'
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc > 1 && argv[1][0] == 'O' && argv[1][1] == 'K') {
        puts("accepted"); return 0;
    }
    puts("rejected"); return 1;
}
C
gcc -g -O0 -fno-pie -no-pie -o fixture fixture.c
python3 - <<'PY'
import numpy as np
from scipy import signal
import matplotlib.pyplot as plt
from scapy.all import Ether, IP, UDP, Raw, wrpcap, rdpcap
import lief
import pwn, elftools, capstone, unicorn, z3, sympy, Crypto
assert np.allclose(np.linalg.solve([[2., 0.], [0., 4.]], [6., 8.]), [3., 2.])
assert signal.convolve([1, 2], [1, 1]).tolist() == [1, 3, 2]
plt.plot([0, 1], [0, 1]); plt.savefig('plot.png')
wrpcap('packet.pcap', [Ether()/IP(src='192.0.2.1', dst='192.0.2.2')/UDP(sport=1234,dport=5678)/Raw(b'ctf-smoke')])
packet = rdpcap('packet.pcap')[0]
assert bytes(packet[Raw]) == b'ctf-smoke' and packet[UDP].dport == 5678
assert lief.parse('fixture') is not None
print('Default Python: NumPy/SciPy/Matplotlib/Scapy/LIEF and existing pwn libraries OK')
PY
angr-python - <<'PY'
import angr, claripy, subprocess
project = angr.Project('./fixture', auto_load_libs=False)
arg = claripy.BVS('argument', 16)
state = project.factory.full_init_state(args=['./fixture', arg])
sim = project.factory.simgr(state)
sim.explore(find=lambda s: b'accepted' in s.posix.dumps(1), avoid=lambda s: b'rejected' in s.posix.dumps(1))
assert sim.found, 'No symbolic solution'
candidate = sim.found[0].solver.eval(arg, cast_to=bytes)
assert subprocess.run(['./fixture', candidate], capture_output=True).stdout == b'accepted\n'
print('angr: found and replayed', candidate)
PY
sage -c 'assert GF(101)(7)^(-1)*7 == 1; assert matrix(ZZ, [[1,2],[3,5]]).LLL().det() in [-1,1]; print("Sage finite field and lattice OK")'
rizin -q -c ij fixture | python3 -c 'import json,sys; assert json.load(sys.stdin)["bin"]["bintype"] == "elf"'
ropper --file fixture --search ret > ropper.log 2>&1
grep -q 'ret' ropper.log
pwndbg -q -batch -ex 'break main' -ex 'run OK' -ex 'telescope $sp 4' --args ./fixture > pwndbg.log 2>&1 || { cat pwndbg.log; exit 1; }
grep -q 'Breakpoint 1,' pwndbg.log
ctf-decompile fixture main.c main
grep -q 'accepted' main.c
# A bad function must fail without making old output look like a successful export.
cp main.c original.c
if ctf-decompile fixture main.c definitely_missing_function; then
    echo 'Missing function unexpectedly succeeded' >&2; exit 1
fi
cmp main.c original.c
printf 'hello\n' > words.txt
printf '5d41402abc4b2a76b9719d911017c592\n' > hashes.txt
POCL_MAX_PTHREAD_COUNT=2 hashcat -m 0 -a 0 -D 1 --potfile-path "$test_dir/hashcat.pot" \
    --restore-disable --quiet hashes.txt words.txt
grep -q ':hello$' hashcat.pot
openssl passwd -1 -salt smoke hello > john.txt
john --wordlist=words.txt --session="$test_dir/john-session" john.txt > john.log 2>&1
john --show john.txt > john-show.log
grep -q ':hello' john-show.log
echo 'Extended solver tools: all functional checks passed.'
