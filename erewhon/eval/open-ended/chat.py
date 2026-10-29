import subprocess,json,os,pathlib,sys,time,threading
# Interactive, read-only evaluation against an authenticated remote CLI.
# Answer the model naturally, one line per turn. EXIT closes the same session.
required=['EREWHON_EVAL_OUTPUT','PI_CODING_AGENT_DIR','EREWHON_EVAL_SSH_HOST','EREWHON_EVAL_SSH_SOCKET']
for key in required:
 if not os.environ.get(key):raise RuntimeError('Set '+key)
out=pathlib.Path(os.environ['EREWHON_EVAL_OUTPUT']);out.mkdir(exist_ok=False,parents=True,mode=0o700)
env=os.environ.copy();env.update(EREWHON_EVAL_TRACE=str(out/'trace.jsonl'),EREWHON_EVAL_READ_ONLY='1')
extension=pathlib.Path(__file__).resolve().parent.parent/'pi-live-extension.mjs'
args=[env.get('EREWHON_EVAL_PI','pi'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','--no-builtin-tools','--no-session','-e',str(extension),'--provider',env.get('EREWHON_EVAL_PROVIDER','local-qwen'),'--model',env.get('EREWHON_EVAL_MODEL','rea-erewhon-qwen35b-eval'),'--thinking','low','--mode','rpc']
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out/'stderr.log','wb'),env=env)
log=open(out/'transcript.jsonl','w');turns=[]
watchdog=threading.Timer(15*60,p.terminate);watchdog.daemon=True;watchdog.start()
print('READY: one persistent Pi session. Enter a prompt per line; EXIT to close.',flush=True)
try:
 for prompt in sys.stdin:
  prompt=prompt.strip()
  if prompt=='EXIT':break
  if not prompt:continue
  turn=len(turns)+1;messages=[];start=time.monotonic()
  p.stdin.write((json.dumps({'id':str(turn),'type':'prompt','message':prompt})+'\n').encode());p.stdin.flush()
  while raw:=p.stdout.readline():
   event=json.loads(raw);log.write(json.dumps({'turn':turn,**event})+'\n');log.flush()
   if event.get('type')=='tool_execution_start':print('TOOL',event.get('toolName'),json.dumps(event.get('args')),flush=True)
   if event.get('type')=='message_end':
    m=event.get('message',{});messages.append(m)
    if m.get('role')=='assistant':
     for c in m.get('content',[]):
      if c.get('type')=='text':print('QWEN:',c['text'],flush=True)
   if event.get('type')=='response'and not event.get('success'):raise RuntimeError(event)
   if event.get('type')=='agent_settled':break
  else:raise RuntimeError('Pi exited')
  calls=[{'name':c['name'],'args':c['arguments']}for m in messages if m.get('role')=='assistant'for c in m.get('content',[])if c.get('type')=='toolCall']
  turns.append({'turn':turn,'prompt':prompt,'seconds':round(time.monotonic()-start,2),'calls':calls,'messages':messages})
  (out/'turns.json').write_text(json.dumps(turns,indent=2))
  print('SETTLED',turn,'calls',len(calls),'seconds',turns[-1]['seconds'],flush=True)
finally:
 watchdog.cancel()
 p.stdin.close()
 try:p.wait(timeout=15)
 except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=10)
 log.close()
