from pathlib import Path
import hashlib,json,re,sys
p=Path(sys.argv[1]);text=p.read_text();block=next(b for b in re.findall(r'```python\n(.*?)\n```',text,re.S) if 'class IdentityMatcher:' in b);ns={};exec(compile(block,str(p),'exec'),ns);match=ns['IdentityMatcher']();cases=[]
def record(name,a,b,rules,expected):
 try:
  actual=match.score_pair(a,b,rules);cases.append({'case':name,'pass':actual==expected,'actual':actual,'expected':expected})
 except Exception as e:cases.append({'case':name,'pass':False,'errorType':type(e).__name__,'error':str(e)})
email=[{'field':'email','normalizer':'email','weight':1}]
record('email_exact',{'email':' A@EXAMPLE.COM '},{'email':'a@example.com'},email,1.0)
record('email_mismatch',{'email':'a@example.com'},{'email':'b@example.com'},email,0.0)
record('nickname',{'name':'Bill'},{'name':'William'},[{'field':'name','normalizer':'name','weight':1}],1.0)
record('missing',{}, {'email':'a@example.com'},email,0.0)
record('empty',{'email':' '},{'email':' '},email,0.0)
record('no_rules',{}, {},[],0.0)
if '--baseline' not in sys.argv:
 for name,weight,method in [('negative_weight',-1,'exact'),('infinite_weight',float('inf'),'exact'),('nan_weight',float('nan'),'exact'),('unsupported_comparator',1,'fuzzy')]:
  try:
   match.score_pair({'email':'a@example.com'},{'email':'a@example.com'},[{'field':'email','weight':weight,'comparator':method}]);cases.append({'case':name,'pass':False,'error':'expectedValueError'})
  except ValueError:cases.append({'case':name,'pass':True})
  except Exception as e:cases.append({'case':name,'pass':False,'errorType':type(e).__name__,'error':str(e)})
print(json.dumps({'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),'executedBlockSha256':hashlib.sha256(block.encode()).hexdigest(),'python':sys.version,'scope':'complete literalIdentityMatcher; no database/graphmutation; subclassscore/weight implementation unchanged','cases':cases,'passed':sum(c['pass'] for c in cases),'failed':sum(not c['pass'] for c in cases)},indent=2));sys.exit(any(not c['pass'] for c in cases))
