"""Fail closed on different source bytes or incomplete canonical converter output."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

MANIFEST = Path(__file__).with_name('manifest.json')
def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def check_bytes(raw, expected_file, expected_blocks):
    if digest(raw) != expected_file:
        raise ValueError('Wrong complete Markdown source bytes')
    blocks = re.findall(rb'```python\n(.*?)\n```', raw, re.S)
    if [digest(block) for block in blocks] != expected_blocks:
        raise ValueError('Wrong literal Python block bytes')

def summary(text):
    matches = re.findall(r'Results: (\d+) passed, (\d+) failed\s+\((\d+) roster agents x (\d+) tools\)', text)
    if matches != [('32', '0', '282', '15')] or not text.rstrip().endswith('PASSED'):
        raise ValueError('Missing, failed or incomplete converter contract')
    return {'passed':32, 'failed':0, 'agents':282, 'tools':15, 'verdict':'PASS'}

def git(root, *args):
    return subprocess.check_output(['git','-C',str(root),*args])

mode = sys.argv[1]
if mode == 'guard':
    root = Path(sys.argv[2]); candidate = sys.argv[3]
    item = json.loads(MANIFEST.read_text())['candidates'][candidate]
    head = git(root,'rev-parse','HEAD').decode().strip()
    parent = git(root,'rev-parse','HEAD^').decode().strip()
    if head != item['head'] or parent != item['base']:
        raise ValueError('Wrong source head or parent')
    names = git(root,'diff','--name-only',item['base'],head).decode().splitlines()
    if names != [item['file']]:
        raise ValueError('Unexpected source file changes')
    before = git(root,'show',f"{item['base']}:{item['file']}")
    after = (root/item['file']).read_bytes()
    check_bytes(before,item['beforeFileSha256'],item['beforeBlocksSha256'])
    check_bytes(after,item['afterFileSha256'],item['afterBlocksSha256'])
    for phase, raw in [('Before', before), ('After', after)]:
        local = MANIFEST.parent/'native-local'/item[f'native{phase}ReceiptFile']
        if digest(local.read_bytes()) != item[f'native{phase}ReceiptSha256']:
            raise ValueError('Wrong pinned original native receipt bytes')
        receipt = json.loads(local.read_text())
        if receipt['sourceSha256'] != digest(raw):
            raise ValueError('Native receipt source differs from checked Git source')
        if phase == 'After' and (receipt['failed'] != 0 or not all(c['pass'] for c in receipt['cases'])):
            raise ValueError('Native after receipt contains a failed case')
    print(json.dumps({'candidate':candidate,'head':head,'parent':parent,'file':item['file'],'fileSha256':digest(after),'nativeAfterReceiptSha256':item['nativeAfterReceiptSha256'],'verdict':'MATCH'},indent=2))
elif mode == 'summary':
    print(json.dumps(summary(Path(sys.argv[2]).read_text()),indent=2))
elif mode == 'self-test':
    cases=[]
    native='Results: 32 passed, 0 failed  (282 roster agents x 15 tools)\nPASSED\n'
    assert summary(native)['verdict']=='PASS';cases.append('healthy_summary')
    for label,text in [('missing_summary','PASSED'),('too_few_checks',native.replace('32 passed','31 passed')),('failed_check',native.replace('0 failed','1 failed')),('too_few_agents',native.replace('282 roster','281 roster')),('missing_tool',native.replace('15 tools','14 tools')),('missing_success_sentinel',native.replace('PASSED',''))]:
        try:summary(text)
        except ValueError:cases.append(label)
        else:raise AssertionError(f'Accepted {label}')
    raw=b'```python\nprint(1)\n```\n';file=digest(raw);blocks=[digest(b'print(1)')]
    check_bytes(raw,file,blocks);cases.append('healthy_source')
    for label,f,b in [('wrong_file_digest','0'*64,blocks),('wrong_block_digest',file,['0'*64])]:
        try:check_bytes(raw,f,b)
        except ValueError:cases.append(label)
        else:raise AssertionError(f'Accepted {label}')
    print(json.dumps({'controls':cases,'passed':len(cases),'verdict':'PASS'},indent=2))
else:
    raise ValueError('Unknown mode')
