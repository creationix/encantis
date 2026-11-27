# python3 cmp.py A.jsonl B.jsonl : totals (debug, release, rse) and per-file release diffs
import json, sys
def load(p):
    d = {}
    for l in open(p):
        r = json.loads(l)
        d[r['file']] = r
    return d
a, b = load(sys.argv[1]), load(sys.argv[2])
errs = [f for f in b if 'error' in b[f]] + [f for f in a if 'error' in a[f]]
if errs: print('ERRORS', errs)
ks = sorted(set(a) & set(b))
if set(a) != set(b): print('file sets differ', set(a) ^ set(b))
for col in ('debug', 'release', 'rse'):
    sa = sum(a[k].get(col, 0) for k in ks); sb = sum(b[k].get(col, 0) for k in ks)
    print(f'{col}: {sa} -> {sb} ({sb - sa:+d})')
for k in ks:
    d = b[k].get('release', 0) - a[k].get('release', 0)
    if d: print(f'  {k}: {a[k]["release"]} -> {b[k]["release"]} ({d:+d})')
