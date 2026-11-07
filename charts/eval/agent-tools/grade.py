import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1]);expected=json.loads(pathlib.Path(sys.argv[2]).read_text())['expected'];summaries=[]
for case in json.loads((root/'results.json').read_text()):
 name=case['case'];turns=case['turns'];final=turns[-1] if turns else {};text=final.get('text','')
 executed=json.loads((root/name/'trace.json').read_text()).get('trace',[]) if (root/name/'trace.json').exists() else []
 calls=[c for t in turns for c in t['calls']]
 checks={'settled':bool(turns) and all(t.get('settled') and not t.get('aborted') for t in turns)}
 results=[t['result'] for t in executed]
 if name in ('overlay','ytd'):
  nums=[abs(float(x)) for x in re.findall(r'[-+]?\d+(?:\.\d+)?(?=\s*%)',text)]
  for symbol in ['BITFINEX:BTCUSD','BITFINEX:BTCUSDLONGS']:
   checks[symbol+'_change']=any(abs(abs(expected[symbol]['changePercent'])-n)<.2 for n in nums)
  checks['year_start_requested']=any('2026-01-01' in str(t['args'].get('from','')) or t['args'].get('period')=='year_to_date' for t in executed)
  checks['no_false_growth_multiple']=not bool(re.search(r'tripled|three.?fold|200\s*%',text,re.I))
  if name=='overlay':
   checks['weak_tracking_explained']=bool(re.search(r'weak|low|not.{0,8}track|poor|little|not.{0,10}strong',text,re.I))
   checks['correct_position_unit']='BCNT' not in text and bool(re.search(r'\bBTC\b',text))
 elif name=='quotes':
  checks['batch_quote']=any(c['name']=='charts_quotes' and set(c['args'].get('symbols',[]))=={'BITFINEX:BTCUSD','BITFINEX:ETHUSD'} for c in calls)
  checks['both_named']='BTC' in text.upper() and 'ETH' in text.upper()
  nums=[float(x) for x in re.findall(r'\d+(?:\.\d+)?',text.replace(',',''))]
  checks['correct_values']=all(any(abs(expected[symbol]['last']-n)<1 for n in nums) for symbol in ['BITFINEX:BTCUSD','BITFINEX:ETHUSD'])
  checks['no_wrong_asof_time']='12:00' not in text
 elif name=='calendar':
  checks['calendar_month']=any(t['args'].get('period')=='last_calendar_month' or (t['args'].get('from','').startswith('2026-10-01') and t['args'].get('to','').startswith('2026-10-31')) for t in executed)
  checks['correct_year']='2026' in text and '2027' not in text
 elif name=='login':
  links=[r.get('clientUrl','') for r in results if r.get('status')=='authorization_required']
  checks['correct_client_link']=any(x and x in text for x in links)
  checks['not_pretending_authenticated']='already connected' not in text.lower()
  checks['correct_receiver_explanation']=not bool(re.search(r'(opens?|launch(?:es)?)\s+TradingView.s\s+native app',text,re.I))
 elif name=='watchlists':
  lists=[r['data'] for r in results if isinstance(r.get('data'),list) and r['data'] and 'entriesTruncated' in r['data'][0]]
  checks['complete_results']=bool(lists) and all(not x['entriesTruncated'] for x in lists[-1])
  checks['last_symbols_visible']='TEST:COIN75' in text and 'NASDAQ:MSFT' in text
  checks['no_omitted_symbols']=all(re.search(r'TEST:COIN'+str(i)+r'(?!\d)',text) for i in range(1,76))
  checks['sections_not_quotes']=not any(str(s).startswith('###') for c in calls for s in c['args'].get('symbols',[]))
 elif name=='study_error':
  checks['no_login_retry']=not any(c['name'] in ['charts_login','charts_logout','charts_auth_cancel','charts_auth_complete'] for c in calls)
  if any(r.get('error') for r in results):
   checks['admits_failure']=bool(re.search(r"fail|unable|cannot|can't|couldn.t|not available|error",text,re.I))
  checks['no_false_access_claim']=not bool(re.search(r'need.{0,30}(paid|premium)|not.{0,10}(logged|signed).{0,5}in|session.{0,15}expired',text,re.I))
  checks['requested_rsi']='62.5' in text
 model_log=root/name/'model-output.jsonl'
 output_bytes=sum(json.loads(line)['bytes'] for line in model_log.read_text().splitlines()) if model_log.exists() else sum(len(json.dumps(t['result'],separators=(',',':')).encode()) for t in executed)
 summary={'case':name,'passed':all(checks.values()),'checks':checks,'toolCalls':len(calls),'executedCalls':len(executed),'outputBytes':output_bytes,'seconds':sum(t['seconds'] for t in turns),'prompts':[t['prompt'] for t in turns],'finalText':text,'calls':calls}
 summaries.append(summary)
print(json.dumps(summaries,indent=2));(root/'grades.json').write_text(json.dumps(summaries,indent=2))
