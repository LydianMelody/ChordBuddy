import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from chordbuddy.confidence import (confidence_defaults, validate_confidence_settings,
                                  read_confidence, token_scores, filter_rhythm, install_capture)


class Tokenizer:
    out_token = 1
    eos_token = 2
    def token_type(self, token):
        return {3:'subbeat_shift', 4:'time', 5:'meter', 6:'eighth_position',
                7:'chord_full', 8:'eighth_position', 9:'pitch', 10:'duration'}[token]
    def token_to_subbeat_shift(self, token):
        return 2


class Row:
    def __init__(self, values): self.values = values
    def argmax(self, dim=-1): return Scalar(max(range(len(self.values)), key=self.values.__getitem__))
    def float(self): return self
    def softmax(self, dim=-1):
        import math
        exp = [math.exp(v) for v in self.values]
        return Row([x / sum(exp) for x in exp])
    def __getitem__(self, index): return Scalar(self.values[index])


class Scalar:
    def __init__(self, value): self.value = value
    def item(self): return self.value


class ConfidenceTests(unittest.TestCase):
    def test_defaults_and_strict_validation(self):
        defaults = confidence_defaults()
        self.assertEqual(list(defaults.values()), [50, 0, 50])
        self.assertEqual(validate_confidence_settings(defaults), defaults)
        for patch in ({'beat_remove_threshold':51}, {'beat_flag_threshold':True},
                      {'chord_flag_threshold':1.5}, {'beat_flag_threshold':-1},
                      {'chord_flag_threshold':101}, {'surprise':0}):
            with self.assertRaises(ValueError): validate_confidence_settings({**defaults, **patch})

    def test_missing_and_bad_scores_are_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(read_confidence(root)['available'])
            (root/'confidence.json').write_text(json.dumps({'schema_version':1,'metric':'grammar_token_probability',
                'beats':[{'time':0,'score':None},{'time':1,'score':float('nan')},{'time':2,'score':1.1},
                         {'time':3,'score':True},{'time':4,'score':.2}], 'chords':[]}))
            self.assertEqual(read_confidence(root)['beats'], [{'time':4.0,'score':.2}])
            (root/'confidence.json').write_text('{}')
            self.assertFalse(read_confidence(root)['available'])

    def test_token_positions_do_not_confuse_repeated_prefix_tokens(self):
        tokenizer = Tokenizer()
        # Prefix uses the same eighth and chord tokens. Only generated positions 10/11 scored.
        tokens = [0,1,3,4,5,6,7,3,4,5,6,7,2]
        scores = token_scores(tokenizer, tokens, {10:(6,.3),11:(7,.8)})
        self.assertEqual(scores, {(4,'rhythm'):(6,.3), (4,'chord'):(7,.8)})
        self.assertNotIn((2,'rhythm'), scores)

    def test_rhythm_filter_preserves_all_other_values_and_meter(self):
        original = {'events':[{'window_index':0,'source_subbeat':2,'time':1,
            'values':{'rhythm':{'eighth_position':0,'meter':[4,4]},'chord':'C:maj',
                      'melody':[{'pitch':60}]}, 'tokens_by_field':{'rhythm':[5,6],'chord':[7]}}]}
        scores = {(0,2,'rhythm'):(6,.1)}
        filtered, removed = filter_rhythm(original, Tokenizer(), scores,20)
        self.assertEqual(removed, 1)
        self.assertEqual(filtered['events'][0]['values']['rhythm'], {'meter':[4,4]})
        self.assertEqual(filtered['events'][0]['tokens_by_field']['rhythm'], [5])
        self.assertEqual(original['events'][0]['values']['rhythm']['eighth_position'],0)
        self.assertEqual(filtered['events'][0]['values']['chord'],'C:maj')
        self.assertEqual(filter_rhythm(original,Tokenizer(),scores,10)[1],0)
        self.assertEqual(filter_rhythm(original,Tokenizer(),{},100)[1],0)

    def test_capture_chains_callbacks_stitches_and_restores_on_export_failure(self):
        tokenizer = Tokenizer()
        calls = []
        def generate(model,audio,prompts,length,**kwargs):
            kwargs['step_callback'](5,[0],None,[Row([0,0,0,0,0,0,2,0,0,0,0])])
            kwargs['step_callback'](6,[0],None,[Row([0,0,0,0,0,0,0,3,0,0,0])])
            return [0,1,3,4,5,6,7,2]
        def export(decoded,tokenizer,output_dir,duration,**kwargs):
            calls.append((decoded,output_dir))
            raise RuntimeError('ABC failed')
        pipeline = SimpleNamespace(constrained_prompt_generate=generate,export_result=export)
        model = SimpleNamespace(tokenizer=tokenizer)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'ABC failed'):
                with install_capture(model,Path(directory),confidence_defaults(),pipeline=pipeline):
                    pipeline.constrained_prompt_generate(model,None,[],20,
                        step_callback=lambda *args:calls.append('chained'))
                    event = {'window_index':0,'source_subbeat':2,'time':1.25,
                             'values':{'rhythm':{'eighth_position':0},'chord':'C:maj'},
                             'tokens_by_field':{'rhythm':[6],'chord':[7]}}
                    pipeline.export_result({'events':[event]},tokenizer,Path(directory),2)
            self.assertIs(pipeline.constrained_prompt_generate,generate)
            self.assertIs(pipeline.export_result,export)
            metadata=read_confidence(Path(directory))
            self.assertTrue(metadata['available'])
            self.assertEqual(metadata['beats'][0]['time'],1.25)
            self.assertEqual(metadata['chords'][0]['label'],'C:maj')
            self.assertEqual(calls.count('chained'),2)

    def test_filter_exports_original_then_derived_and_saves_summary(self):
        tokenizer=Tokenizer()
        calls=[]
        # Selected eighth has deliberately low certainty in this fake model.
        class LowRow(Row):
            def argmax(self,dim=-1): return Scalar(6)
        def generate(model,audio,prompts,length,**kwargs):
            kwargs['step_callback'](5,[0],None,[LowRow([0]*11)])
            return [0,1,3,4,5,6,2]
        def export(decoded,tokenizer,output_dir,duration,**kwargs):
            calls.append((decoded,Path(output_dir)))
            return {'abc_error':None}
        pipeline=SimpleNamespace(constrained_prompt_generate=generate,export_result=export)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            settings={**confidence_defaults(),'beat_remove_threshold':20}
            with install_capture(SimpleNamespace(tokenizer=tokenizer),root,settings,pipeline=pipeline):
                pipeline.constrained_prompt_generate(SimpleNamespace(tokenizer=tokenizer),None,[],20)
                event={'window_index':0,'source_subbeat':2,'time':0,
                    'values':{'rhythm':{'eighth_position':0,'meter':[4,4]}},
                    'tokens_by_field':{'rhythm':[5,6]}}
                pipeline.export_result({'events':[event]},tokenizer,root,1)
            self.assertEqual(calls[0][1],root/'unfiltered')
            self.assertEqual(calls[1][1],root)
            self.assertNotIn('eighth_position',calls[1][0]['events'][0]['values']['rhythm'])
            sidecar=json.loads((root/'confidence.json').read_text())
            self.assertEqual(sidecar['removed_beats'],1)


    def test_removed_beats_with_failed_notation_report_failure_not_fallback(self):
        tokenizer=Tokenizer()
        class LowRow(Row):
            def argmax(self,dim=-1): return Scalar(6)
        def generate(model,audio,prompts,length,**kwargs):
            kwargs['step_callback'](5,[0],None,[LowRow([0]*11)])
            return [0,1,3,4,5,6,2]
        def export(decoded,tokenizer,output_dir,duration,**kwargs):
            return {'abc_error':None if Path(output_dir).name=='unfiltered' else 'No beats'}
        pipeline=SimpleNamespace(constrained_prompt_generate=generate,export_result=export)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with install_capture(SimpleNamespace(tokenizer=tokenizer),root,
                                 {**confidence_defaults(),'beat_remove_threshold':20},pipeline=pipeline):
                pipeline.constrained_prompt_generate(None,None,[],20)
                result=pipeline.export_result({'events':[{'window_index':0,'source_subbeat':2,'time':0,
                    'values':{'rhythm':{'eighth_position':0}},'tokens_by_field':{'rhythm':[6]}}]},tokenizer,root,1)
            self.assertIn('unfiltered outputs are preserved',result['abc_error'])
            self.assertEqual(json.loads((root/'confidence.json').read_text())['filter_status'],'failed')

    def test_grammar_masked_probability_is_compact_scalar(self):
        tokenizer=Tokenizer()
        def generate(model,audio,prompts,length,**kwargs):
            masked=[float('-inf')]*11
            masked[6]=0
            masked[7]=0
            kwargs['step_callback'](5,[0],None,[Row(masked)])
            return [0,1,3,4,5,6,2]
        def export(decoded,tokenizer,output_dir,duration,**kwargs): return {'abc_error':None}
        pipeline=SimpleNamespace(constrained_prompt_generate=generate,export_result=export)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with install_capture(SimpleNamespace(tokenizer=tokenizer),root,confidence_defaults(),pipeline=pipeline):
                pipeline.constrained_prompt_generate(None,None,[],20)
                pipeline.export_result({'events':[{'window_index':0,'source_subbeat':2,'time':0,
                    'values':{'rhythm':{'eighth_position':0}},'tokens_by_field':{'rhythm':[6]}}]},tokenizer,root,1)
            self.assertEqual(read_confidence(root)['beats'],[{'time':0.0,'score':.5}])
            self.assertLess((root/'confidence.json').stat().st_size,1000)
            self.assertFalse((root/'tensors').exists())


if __name__=='__main__': unittest.main()
