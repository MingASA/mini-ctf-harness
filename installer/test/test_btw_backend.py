import contextlib,copy,io,json,os,pathlib,subprocess,sys,tarfile,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import bootstrap,btw_backend as backend,update

class BtwBackend(unittest.TestCase):
    def test_install_plan_supports_one_command_without_downloading(self):
        out=io.StringIO()
        args=bootstrap.parser().parse_args(['--plan','--btw','--cuda-toolkit','/cuda'])
        with contextlib.redirect_stdout(out):bootstrap.install(args)
        plan=json.loads(out.getvalue())
        self.assertEqual(plan['btw_backend']['revision'],bootstrap.MANIFEST['engine_commit'])
        self.assertEqual(plan['btw_backend']['cuda_toolkit'],'/cuda')
        self.assertEqual(plan['btw_backend']['platform'],'linux')

    def test_wsl_btw_plan_uses_linux_runtime(self):
        out=io.StringIO()
        with patch.dict(os.environ,{'WSL_DISTRO_NAME':'Ubuntu'}),contextlib.redirect_stdout(out):
            bootstrap.install(bootstrap.parser().parse_args(['--plan','--btw']))
        plan=json.loads(out.getvalue())
        self.assertEqual(plan['platform'],'linux')
        self.assertIn(bootstrap.MANIFEST['assets']['linux-engine'],plan['assets'])
        self.assertNotIn(bootstrap.MANIFEST['assets']['windows-engine'],plan['assets'])
        self.assertNotIn(bootstrap.MANIFEST['assets']['windows-vcredist'],plan['assets'])

    def test_downloaded_toolkit_components_are_assembled_and_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);archives={}
            for name,entry in [('nvcc','bin/nvcc'),('cudart','include/cuda_runtime.h'),('cublas','lib/libcublas.so')]:
                archive=root/(name+'.tar.xz')
                with tarfile.open(archive,'w:xz') as stream:
                    info=tarfile.TarInfo(name+'-archive/'+entry);info.size=4;stream.addfile(info,io.BytesIO(b'data'))
                archives[name]=archive
            manifest={'version':'12.8.1','components':{k:{'name':k} for k in archives}}
            version=lambda p:(12,8) if (pathlib.Path(p)/'bin/nvcc').is_file() and (pathlib.Path(p)/'include/cuda_runtime.h').is_file() else None
            with patch.object(backend,'TOOLKIT',manifest),patch.object(backend,'fetch_asset',side_effect=lambda asset,_:archives[asset['name']]) as fetch,patch.object(backend,'toolkit_version',side_effect=version):
                directory=backend.install_toolkit(root/'data')
                self.assertTrue((directory/'lib/libcublas.so').is_file());self.assertEqual((directory/'lib64').resolve(),directory/'lib')
                self.assertEqual(backend.install_toolkit(root/'data'),directory);self.assertEqual(fetch.call_count,3)

    def fixture(self,root):
        data=root/'data';workspace=root/'work';source=root/'source';build=root/'build';toolkit=root/'cuda'
        source.mkdir();toolkit.mkdir();(build/'bin').mkdir(parents=True)
        config={'model':{'model':'operator-selected'},'modelRuntime':{'platform':'linux','runDir':'original-run','ramKv':{'reserveMiB':4000},'btw':{'reserveCells':1000}}}
        return data,workspace,source,build,toolkit,config

    def test_build_is_cached_and_only_runtime_settings_change(self):
        with tempfile.TemporaryDirectory() as temp:
            data,work,source,build,toolkit,config=self.fixture(pathlib.Path(temp));before=copy.deepcopy(config)
            def compile_runtime(*args,**kwargs):
                self.assertEqual(args[0][0],'sh')
                (build/'bin/llama-server').write_bytes(b'backend');(build/'bin/libggml-cuda.so.0').write_bytes(b'cuda')
                (build/'bin/libggml-cuda.so').symlink_to('libggml-cuda.so.0')
            with patch.object(backend,'ensure_build_tools'),patch.object(backend,'find_toolkit',return_value=toolkit),patch.object(backend,'architecture',return_value='120a'),patch.object(backend,'build_identity',return_value='a'*64),patch.object(backend,'output',return_value=backend.MANIFEST['engine_commit']),patch.object(backend,'run',side_effect=compile_runtime) as run:
                installed=backend.enable_btw_backend(data,config,work,source_dir=source,build_dir=build)
                backend.enable_btw_backend(data,config,work,source_dir=source,build_dir=build)
                self.assertEqual(run.call_count,1);self.assertTrue(backend.valid_backend(installed,'a'*64))
            self.assertEqual(config['model'],before['model']);self.assertEqual(config['modelRuntime']['ramKv'],before['modelRuntime']['ramKv'])
            self.assertEqual(config['modelRuntime']['runDir'],'original-run');self.assertEqual(config['modelRuntime']['btw'],{'enabled':True,'reserveCells':1000})
            (installed/'llama-server').write_bytes(b'corrupt');self.assertFalse(backend.valid_backend(installed,'a'*64))

    def test_failed_build_preserves_existing_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            data,work,source,build,toolkit,config=self.fixture(pathlib.Path(temp));before=copy.deepcopy(config)
            with patch.object(backend,'ensure_build_tools'),patch.object(backend,'find_toolkit',return_value=toolkit),patch.object(backend,'architecture',return_value='120a'),patch.object(backend,'build_identity',return_value='a'*64),patch.object(backend,'output',return_value=backend.MANIFEST['engine_commit']),patch.object(backend,'run',side_effect=subprocess.CalledProcessError(1,'build')):
                with self.assertRaises(subprocess.CalledProcessError):backend.enable_btw_backend(data,config,work,source_dir=source,build_dir=build)
            self.assertEqual(config,before)

    def test_update_btw_enables_existing_installation_without_model_or_docker_work(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);data=root/'data';data.mkdir();file=data/'config.json';work=root/'work';work.mkdir()
            (root/'offline_harness/node_modules').mkdir(parents=True)
            config={'model':{'model':'operator-selected'},'modelRuntime':{'platform':'linux'},'models':[]};file.write_text(json.dumps(config))
            (root/'.install.json').write_text(json.dumps({'data_dir':str(data),'config':str(file),'workspace':str(work),'node':'/usr/bin/node'}))
            def enable(_data,value,_work,_toolkit):value['modelRuntime']['btw']={'enabled':True}
            with patch.object(update,'ROOT',root),patch.object(update,'output',return_value='head'),patch.object(update,'sync_model_profiles'),patch.object(update,'rebuild_solver') as docker,patch.object(update,'node_dependencies') as npm,patch.object(backend,'enable_btw_backend',side_effect=enable) as build,contextlib.redirect_stdout(io.StringIO()):
                update.apply('head',btw=True,cuda_toolkit='/cuda')
            build.assert_called_once();docker.assert_not_called();npm.assert_not_called()
            actual=json.loads(file.read_text());self.assertEqual(actual['model'],config['model']);self.assertTrue(actual['modelRuntime']['btw']['enabled'])

    def test_update_forwards_flags_through_fast_forward_reexec(self):
        with patch.object(update,'output',side_effect=['','old','origin/feature/btw']),patch.object(update,'run') as run,patch.object(update.os,'execv') as execute:
            update.pull(btw=True,cuda_toolkit='/cuda')
        self.assertEqual(run.call_count,2)
        self.assertEqual(execute.call_args.args[1][-5:],['--apply','old','--btw','--cuda-toolkit','/cuda'])

    def test_normal_update_maintains_enabled_backend_only_when_backend_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);file=root/'config.json';(root/'offline_harness/node_modules').mkdir(parents=True)
            (root/'.install.json').write_text(json.dumps({'data_dir':str(root),'config':str(file),'workspace':str(root),'node':'/usr/bin/node'}))
            for path,expected in [('offline_harness/patches/llama-b12144-btw.patch',1),('README.md',0)]:
                with self.subTest(path=path):
                    file.write_text(json.dumps({'modelRuntime':{'btw':{'enabled':True}}}))
                    with patch.object(update,'ROOT',root),patch.object(update,'output',side_effect=['new',path]),patch.object(update,'sync_model_profiles'),patch.object(backend,'enable_btw_backend') as build,contextlib.redirect_stdout(io.StringIO()):
                        update.apply('old')
                    self.assertEqual(build.call_count,expected)

if __name__=='__main__':unittest.main()
