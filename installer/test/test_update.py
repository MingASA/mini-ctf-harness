import pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from update import changed_actions,sync_model_profiles

class Update(unittest.TestCase):
    def test_changed_paths_select_only_required_expensive_actions(self):
        self.assertEqual(changed_actions(['offline_harness/src/tui.mjs']),{'dependencies':False,'solver_image':False,'model_profiles':False})
        self.assertEqual(changed_actions(['offline_harness/package-lock.json','docker/Dockerfile','installer/assets.json']),{'dependencies':True,'solver_image':True,'model_profiles':True})

    def test_existing_heavy_assets_are_reused_and_all_model_profiles_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);files={name:root/name for name in ('27.gguf','27-mm.gguf','9.gguf','9-mm.gguf')}
            for file in files.values():file.write_bytes(b'present')
            custom={'id':'custom','modelPath':str(root/'custom.gguf')}
            config={'models':[
                {'id':'qwen3.8-27b-iq4xs','modelPath':str(files['27.gguf'])},
                {'id':'qwen3.8-27b-iq4xs-vision','modelPath':str(files['27.gguf']),'mmprojPath':str(files['27-mm.gguf'])},
                {'id':'qwen3.5-9b-ctf-web-q8','modelPath':str(files['9.gguf'])},
                {'id':'qwen3.5-9b-ctf-web-q8-vision','modelPath':str(files['9.gguf']),'mmprojPath':str(files['9-mm.gguf'])},custom]}
            sync_model_profiles(root,config)
            self.assertEqual([profile['id'] for profile in config['models']],['qwen3.8-27b-iq4xs','qwen3.8-27b-iq4xs-vision','qwen3.5-9b-ctf-web-q8','qwen3.5-9b-ctf-web-q8-vision','custom'])
            self.assertEqual(config['models'][2]['modelPath'],str(files['9.gguf']))
            self.assertEqual(config['models'][3]['mmprojPath'],str(files['9-mm.gguf']))

if __name__=='__main__':unittest.main()
