"""Pure bounded waveform-envelope tests; no fixture files or cleanup."""
import unittest
from chordbuddy.separation_audio import waveform_peaks

class WaveformTests(unittest.TestCase):
    def test_all_frames_and_channels_contribute_to_time_aligned_bins(self):
        values=[0,.1, .2,-.3, .4,0, -.5,0, 0,.6, .7,0, .8,0, 0,-.9, .1,1.2]
        result=waveform_peaks({'frames':9,'sample_rate':44100,'channels':2},lambda start,count:values[start*2:(start+count)*2],bins=3)
        self.assertEqual(result['peaks'],[.4,.7,1.2])
        self.assertEqual(result['frames'],9)
        self.assertEqual(result['duration'],9/44100)
    def test_reads_are_bounded_and_last_partial_block_is_included(self):
        calls=[];frames=44103
        def read(start,count):
            calls.append((start,count));return [0.]*(2*count-1)+([.75] if start+count==frames else [0.])
        result=waveform_peaks({'frames':frames,'sample_rate':44100,'channels':2},read,bins=10)
        self.assertEqual(calls,[(0,44100),(44100,3)])
        self.assertEqual(result['peaks'][-1],.75)
        self.assertEqual(sum(result['peaks'][:-1]),0)
    def test_silence_is_not_invented_and_invalid_samples_are_rejected(self):
        info={'frames':2,'sample_rate':44100,'channels':2}
        self.assertEqual(waveform_peaks(info,lambda *_:[0,0,0,0])['peaks'],[0,0])
        with self.assertRaises(ValueError):waveform_peaks(info,lambda *_:[0,float('nan'),0,0])
        with self.assertRaises(ValueError):waveform_peaks(info,lambda *_:[0,0])
        with self.assertRaises(ValueError):waveform_peaks(info,lambda *_:[0,0,0,0],bins=100000)


class WaveformRouteTests(unittest.TestCase):
    def test_validated_route_caches_two_envelopes_and_revalidates_cache_hits(self):
        from types import SimpleNamespace
        from pathlib import Path
        from unittest.mock import Mock, patch
        import threading
        from chordbuddy.server import Handler
        original={'role':'original','frames':3,'sample_rate':44100,'channels':2,'file_sha256':'hash','relative_path':'original.wav'}
        store=SimpleNamespace(get_published_run=Mock(return_value=(Path('qa/u14'),{'assets':[original]})))
        app=SimpleNamespace(separation_store=store,waveform_cache={},waveform_lock=threading.Lock())
        handler=object.__new__(Handler);handler.server=SimpleNamespace(app=app);handler._json=lambda value:value
        with patch('chordbuddy.server.read_frames',return_value=[.1,-.2,.3,-.4,.5,-.6]) as read:
            value=handler._get('/api/waveform/a');self.assertEqual(value['peaks'],[.2,.4,.6]);self.assertEqual(value['run_id'],'a')
            self.assertEqual(handler._get('/api/waveform/a'),value);self.assertEqual(read.call_count,1);self.assertEqual(store.get_published_run.call_count,2)
            for run in ['b','c']:handler._get('/api/waveform/'+run)
            self.assertEqual(len(app.waveform_cache),2);self.assertNotIn(('a','hash'),app.waveform_cache)
            original['file_sha256']='replacement';handler._get('/api/waveform/c');self.assertEqual(read.call_count,4)
            store.get_published_run.side_effect=ValueError('Not published')
            with self.assertRaisesRegex(ValueError,'Not published'):handler._get('/api/waveform/c')
            self.assertEqual(read.call_count,4)
