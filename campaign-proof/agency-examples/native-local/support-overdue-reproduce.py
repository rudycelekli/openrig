import hashlib,json,re,sys
from pathlib import Path
from datetime import datetime,timedelta
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
p=Path(sys.argv[1]);text=p.read_text(); block=next(b for b in re.findall(r'```python\n(.*?)\n```',text,re.S) if 'class SupportAnalytics:' in b)
ns={'__name__':'literal_example'};exec(compile(block,str(p),'exec'),ns)
now=datetime.now();cases=[]
def run(name,statuses,ages,scores,expected):
 df=pd.DataFrame({'customer_id':[name]*len(statuses),'status':pd.Series(statuses,dtype=object),'created_date':[now-timedelta(hours=a) for a in ages],'csat_score':scores})
 actual=ns['SupportAnalytics'](df).create_proactive_outreach_list()
 cases.append({'case':name,'actual':actual,'expected':expected,'pass':actual==expected})
def want(name,overdue=False,volume=False,low=False):
 return {'high_volume_customers':[name] if volume else [],'low_satisfaction_customers':[name] if low else [],'overdue_customers':[name] if overdue else []}
for name,status in [('none',None),('nan',np.nan),('pd_na',pd.NA),('resolved','resolved'),('open_overdue','open')]:run(name,[status],[72],[5],want(name,overdue=name=='open_overdue'))
run('open_recent',['open'],[1],[5],want('open_recent'))
run('known_high_volume',['resolved']*3,[1,2,3],[5]*3,want('known_high_volume',volume=True))
run('known_low_csat',['resolved'],[1],[2],want('known_low_csat',low=True))
run('missing_status_volume',[None,np.nan,pd.NA],[1,2,3],[5]*3,want('missing_status_volume',volume=True))
run('missing_status_low_csat',[None],[1],[2],want('missing_status_low_csat',low=True))
print(json.dumps({'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),'executedBlockSha256':hashlib.sha256(block.encode()).hexdigest(),'python':sys.version,'pandas':pd.__version__,'scope':'complete literalSupportAnalytics block loaded unchanged; actualoutreach producer executes; no account/customer actions','cases':cases,'passed':sum(c['pass'] for c in cases),'failed':sum(not c['pass'] for c in cases)},indent=2));sys.exit(any(not c['pass'] for c in cases))
