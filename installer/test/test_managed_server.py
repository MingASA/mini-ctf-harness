import importlib.util,json,pathlib,socket,subprocess,sys,tempfile,time,unittest,os,signal
SCRIPT=pathlib.Path(__file__).resolve().parents[2]/'offline_harness/scripts/managed_server.py'
spec=importlib.util.spec_from_file_location('managed',SCRIPT);managed=importlib.util.module_from_spec(spec);spec.loader.exec_module(managed)
class ManagedServer(unittest.TestCase):
    def test_actual_linux_owner_and_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);config=root/'selection.json'
            with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
            code="from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{\"status\":\"ok\"}')\nHTTPServer(('127.0.0.1',"+str(port)+"),H).serve_forever()"
            c={'root':str(root),'requestId':'one','key':'one','model':'fixture','exe':sys.executable,'args':['-c',code],'baseUrl':f'http://127.0.0.1:{port}'};config.write_text(json.dumps(c))
            try:
                subprocess.run([sys.executable,str(SCRIPT),str(config)],check=True,timeout=10);first=json.loads((root/'owner.json').read_text());self.assertTrue(managed.identity(first['pid']))
                c.update(requestId='two',key='two');config.write_text(json.dumps(c));subprocess.run([sys.executable,str(SCRIPT),str(config)],check=True,timeout=10);second=json.loads((root/'owner.json').read_text());self.assertNotEqual(first['pid'],second['pid']);self.assertEqual(second['key'],'two')
            finally:
                if (root/'owner.json').exists():
                    record=json.loads((root/'owner.json').read_text())
                    try:os.killpg(record['pid'],signal.SIGTERM)
                    except ProcessLookupError:pass
if __name__=='__main__':unittest.main()
