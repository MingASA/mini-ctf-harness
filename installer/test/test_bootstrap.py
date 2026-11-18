import contextlib,hashlib,http.server,io,json,pathlib,sys,tarfile,tempfile,threading,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from bootstrap import configured_models,fetch_asset,install,unpack,parser,MANIFEST

class ModelProfiles(unittest.TestCase):
    def test_vision_profile_has_distinct_alias_and_preserves_user_models(self):
        model_id = 'qwen3.8-27b-iq4xs'
        custom = {'id': 'local-text-model', 'modelPath': '/models/local.gguf'}
        existing = [{'id': model_id, 'contextTokens': 40960, 'gpuLayers': 20}, custom]
        text, vision, qwen35, qwen35_vision, extra = configured_models(
            '/models/27b.gguf', '/models/projector.gguf',
            '/models/9b.gguf', '/models/9b-projector.gguf', existing
        )
        self.assertEqual(extra, custom)
        self.assertNotIn('nativeImages', text)
        self.assertEqual(vision['model'], model_id + '-vision')
        self.assertEqual(vision['modelPath'], text['modelPath'])
        self.assertEqual(vision['mmprojPath'], '/models/projector.gguf')
        self.assertTrue(vision['nativeImages'])
        self.assertEqual(vision['contextTokens'], 40960)
        self.assertEqual(vision['gpuLayers'], 20)
        self.assertEqual(qwen35['id'], 'qwen3.5-9b-ctf-web-q8')
        self.assertEqual(qwen35['modelPath'], '/models/9b.gguf')
        self.assertEqual(qwen35_vision['model'], 'qwen3.5-9b-ctf-web-q8-vision')
        self.assertEqual(qwen35_vision['mmprojPath'], '/models/9b-projector.gguf')
        self.assertTrue(qwen35_vision['nativeImages'])
        self.assertEqual(
            configured_models('/models/27b.gguf', '/models/projector.gguf', '/models/9b.gguf', '/models/9b-projector.gguf', [text, vision, qwen35, qwen35_vision, extra]),
            [text, vision, qwen35, qwen35_vision, extra],
        )

class Downloads(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.raw=b'new model bytes\n'*400;raw=self.raw;self.requests=[];requests=self.requests
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                offset=int(self.headers.get('Range','bytes=0-').split('=')[1].split('-')[0]);requests.append(offset)
                self.send_response(206 if offset else 200)
                if offset:self.send_header('Content-Range',f'bytes {offset}-{len(raw)-1}/{len(raw)}')
                self.end_headers();self.wfile.write(raw[offset:])
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.asset={'name':'model.gguf','url':f'http://127.0.0.1:{self.server.server_port}/model','sha256':hashlib.sha256(raw).hexdigest(),'size':len(raw)}
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def test_resume_and_cached_verification(self):
        (self.root/'model.gguf.part').write_bytes(self.raw[:137]);file=fetch_asset(self.asset,self.root);self.assertEqual(file.read_bytes(),self.raw);self.assertEqual(self.requests,[137]);fetch_asset(self.asset,self.root);self.assertEqual(self.requests,[137])
    def test_reject_corrupt_cache_and_complete_download(self):
        bad=dict(self.asset,sha256='0'*64)
        with self.assertRaisesRegex(ValueError,'Checksum'):fetch_asset(bad,self.root)
        self.assertFalse((self.root/'model.gguf').exists());(self.root/'model.gguf').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError,'Checksum'):fetch_asset(self.asset,self.root)
    def test_archive_traversal(self):
        archive=self.root/'bad.tar'
        with tarfile.open(archive,'w') as out:
            info=tarfile.TarInfo('../outside');info.size=3;out.addfile(info,io.BytesIO(b'bad'))
        with self.assertRaisesRegex(ValueError,'escaped'):unpack(archive,self.root/'out')
        self.assertFalse((self.root/'outside').exists())
    def test_pinned_manifest_and_valid_plan(self):
        for asset in MANIFEST['assets'].values():self.assertRegex(asset['sha256'],r'^[a-f0-9]{64}$');self.assertTrue(asset['url'].startswith('https://'))
        self.assertEqual(MANIFEST['assets']['qwen3.5-9b-ctf-web-q8']['size'],9786060032)
        self.assertEqual(MANIFEST['assets']['qwen3.5-9b-projector']['size'],918166080)
        self.assertEqual(parser().parse_args(['--plan']).model,'qwen3.8-27b-iq4xs')
        output=io.StringIO()
        with contextlib.redirect_stdout(output):install(parser().parse_args(['--plan','--data-dir',str(self.root/'data')]))
        names={asset['name'] for asset in json.loads(output.getvalue())['assets']}
        self.assertTrue({'Qwen3.8-27B-UD-IQ4_XS.gguf','mmproj-Qwen3.8-27B-F16.gguf','qwen3.5-9B-ctf-instruct-experiment.gguf','mmproj-Qwen3.5-9B-F16.gguf'}<=names)
if __name__=='__main__':unittest.main()
