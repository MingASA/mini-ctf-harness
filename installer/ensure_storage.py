#!/usr/bin/env python3
import pathlib,os,json,sys
from bootstrap import privileged,ROOT
s=json.loads((ROOT/'.install.json').read_text());privileged(['python3',ROOT/'installer/storage.py',s['data_dir'],'--uid',os.getuid(),'--gid',os.getgid()])
