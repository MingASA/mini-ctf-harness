#!/usr/bin/env python3
"""Export Ghidra C pseudocode; no project setup or Java scripting needed."""
import argparse
import os
import pathlib
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path, help='C output file; never the input binary')
    parser.add_argument('functions', nargs='*', help='Function names or addresses; omit to export all functions')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.output.resolve()
    if not binary.is_file() or binary == output:
        parser.error('Use a regular input binary and a different output file')
    output.parent.mkdir(parents=True, exist_ok=True)
    # A private project/output prevents stale results and collisions between tasks.
    # Ghidra rejects hidden components in project paths; output directories may be hidden.
    with tempfile.TemporaryDirectory(prefix='ghidra-', dir='/work') as temporary:
        root = pathlib.Path(temporary)
        exported = root / 'functions.c'
        log = output.with_name(output.name + '.ghidra.log')
        command = ['analyzeHeadless', str(root), 'analysis', '-import', str(binary),
                   '-scriptPath', '/opt/ctf-ghidra', '-postScript', 'ExportFunctions.java',
                   str(exported), *args.functions, '-deleteProject']
        with log.open('w') as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode or not exported.is_file():
            raise SystemExit(f'Ghidra export failed; inspect {log}')
        fd, staging = tempfile.mkstemp(prefix='.' + output.name + '-', dir=output.parent)
        try:
            with os.fdopen(fd, 'wb') as destination, exported.open('rb') as source:
                shutil.copyfileobj(source, destination)
            os.replace(staging, output)
        finally:
            pathlib.Path(staging).unlink(missing_ok=True)
    print(f'C pseudocode: {output}\nAnalysis log: {log}')


if __name__ == '__main__':
    main()
