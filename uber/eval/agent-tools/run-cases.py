# Pi evaluation harness. See README.md for setup and isolation guarantees.
import os, pathlib, json, subprocess, sys
root = pathlib.Path(__file__).resolve().parent
required = ['PI_CODING_AGENT_DIR', 'EATS_EVAL_OUTPUT']
for name in required:
    if not os.environ.get(name):
        raise RuntimeError('Set ' + name)
out = pathlib.Path(os.environ['EATS_EVAL_OUTPUT'])
out.mkdir(parents=True, exist_ok=False, mode=448)
source = subprocess.run(['node', '--input-type=module', '-e', 'import{scenarios}from' + json.dumps((root / 'scenarios.mjs').as_uri()) + ';console.log(JSON.stringify(scenarios))'], capture_output=True, text=True, check=True)
scenarios = json.loads(source.stdout)
for key in sys.argv[1:] or scenarios:
    env = os.environ.copy()
    env.update(EATS_EVAL_OUTPUT=str(out / key), EATS_EVAL_CASE=key, EATS_EVAL_EXTENSION=str(root / 'pi-fixture-extension.mjs'), EATS_EVAL_STATE=str(out / (key + '-state.json')))
    prompts = '\n'.join(scenarios[key]['prompts']) + '\nEXIT\n'
    print('CASE', key, flush=True)
    r = subprocess.run([sys.executable, str(root / 'chat.py')], input=prompts, text=True, env=env)
    if r.returncode:
        raise RuntimeError('Pi run failed: ' + key)
