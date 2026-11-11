"""Local Qwen / Pi RPC evaluation. No cloud model, shell tools, or live mutations."""
import json, os, pathlib, subprocess, sys, threading, time

root=pathlib.Path(__file__).resolve().parent
node=os.environ.get('CHARTS_EVAL_NODE','node')
out=pathlib.Path(os.environ['CHARTS_EVAL_OUTPUT'])
out.mkdir(parents=True,exist_ok=False,mode=0o700)
scenario_module=pathlib.Path(os.environ.get('CHARTS_EVAL_SCENARIOS',root/'scenarios.mjs')).resolve()
source=subprocess.run([node,'--input-type=module','-e','import{scenarios}from'+json.dumps(scenario_module.as_uri())+';console.log(JSON.stringify(scenarios))'],capture_output=True,text=True,check=True)
scenarios=json.loads(source.stdout)
all_turns=[]
for name in sys.argv[1:] or scenarios:
    case_dir=out/name;case_dir.mkdir(mode=0o700)
    env=os.environ.copy();env.update(CHARTS_EVAL_CASE=name,CHARTS_EVAL_CASE_DIR=str(case_dir))
    env['PATH']=str(pathlib.Path(node).resolve().parent)+os.pathsep+env.get('PATH','')
    args=[env.get('CHARTS_EVAL_PI','/opt/homebrew/bin/pi'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','--no-builtin-tools','--no-session','-e',str(root/'pi-extension.mjs'),'--provider','local-qwen','--model',env.get('CHARTS_EVAL_MODEL','rea-charts-qwen35b-eval'),'--thinking','off','--mode','rpc']
    err=open(case_dir/'stderr.log','wb')
    process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,env=env)
    transcript=open(case_dir/'transcript.jsonl','w')
    watchdog=threading.Timer(360,process.terminate);watchdog.daemon=True;watchdog.start()
    turns=[]
    print('CASE',name,flush=True)
    try:
        for index,prompt in enumerate(scenarios[name]['prompts']):
            process.stdin.write((json.dumps({'id':str(index),'type':'prompt','message':prompt})+'\n').encode());process.stdin.flush()
            messages=[];started=time.monotonic();calls=0;aborted=False;settled=False
            for raw in process.stdout:
                event=json.loads(raw);transcript.write(json.dumps({'turn':index+1,**event})+'\n');transcript.flush()
                if event.get('type')=='tool_execution_start':
                    calls+=1;print('TOOL',event.get('toolName'),json.dumps(event.get('args')),flush=True)
                    if calls>=12 and not aborted:
                        aborted=True;process.stdin.write((json.dumps({'id':'abort','type':'abort'})+'\n').encode());process.stdin.flush()
                if event.get('type')=='message_end':messages.append(event.get('message',{}))
                if event.get('type')=='response' and not event.get('success',True):raise RuntimeError(str(event))
                if event.get('type')=='agent_settled':settled=True;break
            attempted=[{'name':c['name'],'args':c['arguments']} for m in messages if m.get('role')=='assistant' for c in m.get('content',[]) if c.get('type')=='toolCall']
            text='\n'.join(c['text'] for m in messages if m.get('role')=='assistant' for c in m.get('content',[]) if c.get('type')=='text')
            turn={'prompt':prompt,'calls':attempted,'text':text,'messages':messages,'seconds':round(time.monotonic()-started,2),'aborted':aborted,'settled':settled}
            turns.append(turn);(case_dir/'turns.json').write_text(json.dumps(turns,indent=2))
            print('RESULT',json.dumps({'case':name,'turn':index+1,'calls':len(attempted),'seconds':turn['seconds'],'text':text[-2200:]}),flush=True)
            if not settled:break
    except Exception as e:
        print('ERROR',name,str(e),flush=True)
        (case_dir/'error.txt').write_text(str(e))
    finally:
        watchdog.cancel();process.stdin.close()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=5)
        transcript.close();err.close()
    all_turns.append({'case':name,'turns':turns,'exitCode':process.returncode})
    (out/'results.json').write_text(json.dumps(all_turns,indent=2))
