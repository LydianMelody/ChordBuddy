"""Compact, uncalibrated prediction certainty; no torch dependency in the app."""
from contextlib import contextmanager
import copy
import importlib
import json
import math
import time
from pathlib import Path

METRIC = 'grammar_token_probability'


def confidence_defaults():
    return {'beat_flag_threshold':50, 'beat_remove_threshold':0, 'chord_flag_threshold':50}


def opacity_defaults():
    """Display-only confidence opacity settings.

    These values deliberately live outside ``confidence_defaults``: they are
    presentation preferences and must never be written to worker run options.
    """
    return {'chord_opacity_min': 40, 'chord_opacity_max': 100}


def validate_opacity_settings(values):
    if not isinstance(values, dict) or set(values) != set(opacity_defaults()):
        raise ValueError('Chord opacity settings must contain exactly the minimum and maximum opacity')
    if any(type(value) is not int or not 0 <= value <= 100 for value in values.values()):
        raise ValueError('Chord opacity must be integer percentages from 0 to 100')
    if values['chord_opacity_min'] > values['chord_opacity_max']:
        raise ValueError('Minimum chord opacity cannot exceed the maximum')
    return dict(values)


def validate_confidence_settings(values):
    if not isinstance(values,dict) or set(values) != set(confidence_defaults()):
        raise ValueError('Confidence settings must contain exactly the three confidence thresholds')
    result = dict(values)
    if any(type(value) is not int or not 0 <= value <= 100 for value in result.values()):
        raise ValueError('Confidence thresholds must be integer percentages from 0 to 100')
    if result['beat_remove_threshold'] > result['beat_flag_threshold']:
        raise ValueError('Beat removal threshold cannot exceed the beat warning threshold')
    return result


def _finite(value, low=0, high=None):
    return (type(value) in (int,float) and math.isfinite(value) and value >= low
            and (high is None or value <= high))


def read_confidence(run_dir):
    """Unknown or corrupt metadata is unavailable, never a fabricated low score."""
    result={'beats':[], 'chords':[], 'metric':METRIC, 'available':False,'removed_beats':0,'filter_status':'unknown'}
    try:
        value=json.loads((Path(run_dir)/'confidence.json').read_text(encoding='utf-8'))
        if value.get('schema_version') != 1 or value.get('metric') != METRIC:
            return result
        removed=value.get('removed_beats')
        if type(removed) is int and removed>=0:result['removed_beats']=removed
        if value.get('filter_status') in ('unchanged','applied','failed','pending'):result['filter_status']=value['filter_status']
        for field in ('beats','chords'):
            rows=value.get(field,[])
            if not isinstance(rows,list): continue
            for row in rows:
                if not isinstance(row,dict) or not _finite(row.get('time')) or not _finite(row.get('score'),high=1):
                    continue
                clean={'time':float(row['time']), 'score':float(row['score'])}
                if field=='chords' and isinstance(row.get('label'),str): clean['label']=row['label']
                result[field].append(clean)
        result['available']=bool(result['beats'] or result['chords'])
        return result
    except (OSError,ValueError,TypeError,AttributeError):
        return result


def score_at_time(confidence, time, tolerance=1e-3):
    """Return the recorded raw beat score nearest *time*, if available."""
    rows = confidence.get('beats', []) if isinstance(confidence, dict) else []
    candidates = [row for row in rows if isinstance(row, dict) and
                  _finite(row.get('time')) and _finite(row.get('score'), high=1) and
                  abs(float(row['time']) - float(time)) <= tolerance]
    if not candidates:
        return None
    return min(candidates, key=lambda row: abs(float(row['time']) - float(time)))['score']


def filter_beat_times(times, confidence, threshold, tolerance=1e-3):
    """Filter raw beat times using scores while retaining unscored beats.

    ``confidence.json`` always contains the raw scores.  Keeping this as a
    pure projection means moving the tolerance in either direction restores
    beats without invoking the transcription model.
    """
    if type(threshold) is not int or not 0 <= threshold <= 100 or threshold <= 0:
        return list(times)
    return [time for time in times if (score := score_at_time(confidence, time, tolerance)) is None
            or float(score) * 100 >= threshold]


def token_scores(tokenizer,tokens,positions):
    """Associate exact generated token indices to source subbeats, including prefixes."""
    if hasattr(tokens,'tolist'): tokens=tokens.tolist()
    tokens=[int(token) for token in tokens]
    start=tokens.index(tokenizer.out_token)+1
    subbeat=0
    result={}
    for index in range(start,len(tokens)):
        token=tokens[index]
        if token==tokenizer.eos_token: break
        kind=tokenizer.token_type(token)
        if kind=='subbeat_shift': subbeat+=tokenizer.token_to_subbeat_shift(token)
        if index not in positions: continue
        selected,score=positions[index]
        if token!=selected or not _finite(score,high=1):
            raise RuntimeError('Confidence token index does not match generated tokens')
        if kind=='eighth_position': result[(subbeat,'rhythm')]=(token,score)
        elif kind in ('chord_full','chord_majmin'): result[(subbeat,'chord')]=(token,score)
    return result


def _event_score(event,field,scores,tokenizer):
    key=(int(event.get('window_index',-1)),int(event.get('source_subbeat',-1)),field)
    estimate=scores.get(key)
    if estimate is None: return None
    token,score=estimate
    actual=event.get('tokens_by_field',{}).get(field,[])
    # Inherited prefix-context values have no generated probability.
    if token not in actual: return None
    return score


def filter_rhythm(decoded,tokenizer,scores,threshold):
    """Remove beat-position annotations only; preserve meter changes and all music."""
    filtered=copy.deepcopy(decoded)
    removed=0
    for event in filtered['events']:
        score=_event_score(event,'rhythm',scores,tokenizer)
        if threshold<=0 or score is None or score*100>=threshold: continue
        rhythm=event.get('values',{}).get('rhythm',{})
        if 'eighth_position' not in rhythm: continue
        rhythm.pop('eighth_position')
        tokens=event.get('tokens_by_field',{}).get('rhythm',[])
        tokens=[token for token in tokens if tokenizer.token_type(token)!='eighth_position']
        if rhythm: event['values']['rhythm']=rhythm
        else: event['values'].pop('rhythm',None)
        if tokens: event['tokens_by_field']['rhythm']=tokens
        else: event['tokens_by_field'].pop('rhythm',None)
        removed+=1
    return filtered,removed


def _write(path,value):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    payload=json.dumps(value,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('utf-8')
    # Export commonly leaves the sidecar unchanged. Do not replace a file that
    # a reader may still have open merely to write the same bytes again.
    if path.exists() and path.read_bytes()==payload:return
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_bytes(payload)
    for attempt in range(6):
        try:
            temporary.replace(path)
            return
        except PermissionError as exc:
            if getattr(exc,'winerror',None) not in (5,32,33) or attempt==5:
                raise PermissionError('Could not save confidence metadata: Windows refused the file replacement. '
                                      'Existing metadata and exported files are preserved. '+str(path)) from exc
            time.sleep(.025*2**attempt)


@contextmanager
def install_capture(model,output_dir,settings,*,pipeline=None):
    """Worker-local hooks, restored even when generation or notation raises.

    The pinned pipeline owns these function globals. Capture receives each masked
    vector transiently, retaining only scalar certainty for rhythm/chord choices.
    Final stitching supplies window_index/source_subbeat, avoiding token-value
    search collisions with repeated prefix events.
    """
    settings=validate_confidence_settings(settings)
    if pipeline is None:
        package=model.__class__.__module__.rsplit('.',1)[0]
        pipeline=importlib.import_module(package+'.pipeline_sheetsage2')
    original_generate=pipeline.constrained_prompt_generate
    original_export=pipeline.export_result
    scores={}
    window_index=0
    output_dir=Path(output_dir)

    def generate(*args,**kwargs):
        nonlocal window_index
        index=window_index
        window_index+=1
        chained=kwargs.get('step_callback')
        positions={}
        def capture(position,active_sample_ids,logits,masked_logits):
            for row_index,sample_id in enumerate(active_sample_ids):
                if sample_id!=0:
                    raise RuntimeError('Confidence capture requires single-song generation')
                row=masked_logits[row_index]
                token=int(row.argmax(dim=-1).item())
                kind=model.tokenizer.token_type(token)
                if kind in ('eighth_position','chord_full','chord_majmin'):
                    score=float(row.float().softmax(dim=-1)[token].item())
                    if not _finite(score,high=1):
                        raise RuntimeError('Model produced non-finite confidence')
                    positions[int(position)]=(token,score)
            if chained is not None: chained(position,active_sample_ids,logits,masked_logits)
        kwargs['step_callback']=capture
        tokens=original_generate(*args,**kwargs)
        for (subbeat,field),estimate in token_scores(model.tokenizer,tokens,positions).items():
            scores[(index,subbeat,field)]=estimate
        return tokens

    def export(decoded,tokenizer,directory=None,duration=None,*args,**kwargs):
        beats,chords=[],[]
        for event in decoded['events']:
            time=event.get('time')
            if not _finite(time): continue
            for field,target in (('rhythm',beats),('chord',chords)):
                score=_event_score(event,field,scores,tokenizer)
                if score is None: continue
                row={'time':float(time),'score':score}
                if field=='chord': row['label']=event['values']['chord']
                target.append(row)
        filtered,removed=filter_rhythm(decoded,tokenizer,scores,settings['beat_remove_threshold'])
        sidecar={'schema_version':1,'metric':METRIC,'beats':beats,'chords':chords,
                 'thresholds':settings,'removed_beats':removed,
                 'filter_status':'pending' if removed else 'unchanged'}
        _write(output_dir/'confidence.json',sidecar)
        try:
            if settings['beat_remove_threshold']>0:
                original_export(decoded,tokenizer,output_dir/'unfiltered',duration,*args,**kwargs)
            result=original_export(filtered if removed else decoded,tokenizer,directory,duration,*args,**kwargs)
            sidecar['filter_status']='failed' if removed and result.get('abc_error') else ('applied' if removed else 'unchanged')
            if removed and result.get('abc_error'):
                result['abc_error']='Confidence filtering could not produce a usable score; unfiltered outputs are preserved. '+str(result['abc_error'])
        except Exception as exc:
            sidecar['filter_status']='failed'
            try:_write(output_dir/'confidence.json',sidecar)
            except OSError as metadata_error:exc.add_note('Could not save confidence failure metadata: '+str(metadata_error))
            raise
        _write(output_dir/'confidence.json',sidecar)
        return result

    pipeline.constrained_prompt_generate=generate
    pipeline.export_result=export
    try:
        yield
    finally:
        pipeline.constrained_prompt_generate=original_generate
        pipeline.export_result=original_export
