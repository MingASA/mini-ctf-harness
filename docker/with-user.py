#!/usr/bin/env python3
"""Give password tools a passwd identity for the sandbox's arbitrary numeric UID."""
import os
import pathlib
import pwd
import subprocess
import sys
import tempfile

program = pathlib.Path(sys.argv[0]).name
executable = {'hashcat': '/usr/bin/hashcat', 'john': '/usr/sbin/john'}[program]
uid, gid = os.getuid(), os.getgid()
home = pathlib.Path(os.environ.get('HOME', '/work')).resolve()
if ':' in str(home) or '\n' in str(home):
    raise SystemExit('HOME cannot contain passwd field separators')
try:
    name = pwd.getpwuid(uid).pw_name
except KeyError:
    name = 'solver-' + str(uid)
with tempfile.TemporaryDirectory(prefix='ctf-user-', dir=home) as temporary:
    root = pathlib.Path(temporary)
    passwd = [line for line in pathlib.Path('/etc/passwd').read_text().splitlines()
              if line.split(':')[2] != str(uid)]
    groups = [line for line in pathlib.Path('/etc/group').read_text().splitlines()
              if line.split(':')[2] != str(gid)]
    passwd.append(f'{name}:x:{uid}:{gid}:CTF solver:{home}:/bin/sh')
    groups.append(f'solver-{gid}:x:{gid}:')
    (root/'passwd').write_text('\n'.join(passwd)+'\n')
    (root/'group').write_text('\n'.join(groups)+'\n')
    env = {**os.environ, 'NSS_WRAPPER_PASSWD': str(root/'passwd'), 'NSS_WRAPPER_GROUP': str(root/'group'),
           'LD_PRELOAD': '/usr/lib/x86_64-linux-gnu/libnss_wrapper.so ' + os.environ.get('LD_PRELOAD', '')}
    result = subprocess.run([executable, *sys.argv[1:]], env=env)
    raise SystemExit(result.returncode if result.returncode >= 0 else 128-result.returncode)
