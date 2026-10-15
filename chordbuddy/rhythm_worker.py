"""Contained CPU proposal worker; no model loading or downloads."""
import argparse,json
from pathlib import Path
from chordbuddy.rhythm import analyze_drum_rhythm

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--project',type=Path,required=True);parser.add_argument('--request',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    root=args.project.resolve()
    for path in (args.request,args.output):
        if not path.resolve().is_relative_to(root):raise ValueError('Worker path escapes project')
    request=json.loads(args.request.read_text(encoding='utf-8'))
    if not Path(request['drums']).resolve().is_relative_to(root):raise ValueError('Drums escape project')
    result=analyze_drum_rhythm(request['drums'],request['baseline'],request['provenance'],request.get('settings',{}),lambda:None,lambda value:print(json.dumps(value),flush=True))
    args.output.write_text(json.dumps(result,allow_nan=False),encoding='utf-8')
if __name__=='__main__':main()
