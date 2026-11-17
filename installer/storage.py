#!/usr/bin/env python3
"""Prepare only the requested installation's Linux storage."""
import argparse,json,os,pathlib,subprocess,hashlib

def run(args):return subprocess.check_output(list(map(str,args)),text=True).strip()
def prepare(root,uid,gid,size_gib):
    root=pathlib.Path(root).resolve();root.mkdir(parents=True,exist_ok=True);target=root/'workspace';target.mkdir(exist_ok=True)
    kind=run(['findmnt','-n','-o','FSTYPE','-T',root])
    if kind in ('9p','drvfs','ntfs','fuseblk'):
        image=root/'workspace.ext4';marker=root/'workspace-image.json'
        if not image.exists():
            with image.open('xb'):pass
            if kind=='9p' and os.environ.get('WSL_DISTRO_NAME'):
                windows=run(['wslpath','-w',image])
                subprocess.run(['/mnt/c/Windows/System32/fsutil.exe','sparse','setflag',windows],cwd=str(root),check=True,stdout=subprocess.DEVNULL)
            with image.open('r+b') as f:f.truncate(size_gib*1024**3)
            run(['mkfs.ext4','-q','-F',image]);marker.write_text(json.dumps({'image':str(image),'size':image.stat().st_size}))
        if image.is_symlink() or not marker.exists():raise RuntimeError('Storage image identity is unrecognized')
        if subprocess.run(['mountpoint','-q',str(target)]).returncode:run(['mount','-t','ext4','-o','loop,noatime',image,target])
        source=run(['findmnt','-n','-o','SOURCE','-T',target]);backing=run(['losetup','-n','-O','BACK-FILE',source])
        if pathlib.Path(backing).resolve()!=image:raise RuntimeError('Unexpected storage image is mounted')
    os.chown(target,uid,gid)
    for name in ['tmp','cache','bin','runtime','offline-harness/work']:
        p=target/name;p.mkdir(parents=True,exist_ok=True);os.chown(p,uid,gid)
    return str(target)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);p.add_argument('--size-gib',type=int,default=24);a=p.parse_args()
    if os.geteuid()!=0:raise SystemExit('Storage preparation requires root')
    print(prepare(a.root,a.uid,a.gid,a.size_gib))
