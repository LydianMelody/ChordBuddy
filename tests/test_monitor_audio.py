import threading
import io
import json
import wave
import zipfile
from types import SimpleNamespace

import numpy as np
import pytest

from chordbuddy.cue_tracks import CueTracks
from chordbuddy.monitor_audio import CueVoice,MonitorAudio,MonitorMixer

RATE=48000


def first_sound(out):
    loud=np.flatnonzero(np.abs(out[:,0])>1e-4)
    return max(0,int(loud[0])-1) if len(loud) else None     # a tick starts from zero, so it shows one sample after it begins


def mixer(click=1.0,cue=1.0):
    m=MonitorMixer(RATE);m.gain.update(click=click,cue=cue);m.goal.update(click=click,cue=cue);return m


def test_a_click_lands_on_its_sample_inside_a_buffer():
    m=mixer();m.post('event',10.0025,'click',{})
    out=m.render(480,10.0)
    assert first_sound(out)==120
    assert m.played==1 and m.missed==0


def test_a_click_rings_on_into_the_next_buffer_and_ends():
    m=mixer();m.post('event',10.0,'click',{})
    assert first_sound(m.render(480,10.0))==0
    assert first_sound(m.render(480,10.01)) is not None
    for i in range(2,6):m.render(480,10+i*.01)
    assert first_sound(m.render(480,10.06)) is None


def test_the_accent_is_a_different_sound():
    assert not np.array_equal(MonitorMixer(RATE).sounds[True],MonitorMixer(RATE).sounds[False])


def test_a_click_too_late_to_be_on_the_beat_is_left_out():
    m=mixer();m.post('event',9.9,'click',{});m.post('event',9.995,'click',{})
    out=m.render(480,10.0)
    assert m.missed==1 and m.played==1 and m.late==1
    assert first_sound(out)==0


def test_the_fader_sets_the_level_and_zero_is_silent():
    loud=mixer(click=1.0);loud.post('event',10.0,'click',{})
    soft=mixer(click=.25);soft.post('event',10.0,'click',{})
    off=mixer(click=0.0);off.post('event',10.0,'click',{})
    a=np.abs(loud.render(480,10.0)).max();b=np.abs(soft.render(480,10.0)).max()
    assert b==pytest.approx(a*.25,rel=.01)
    assert first_sound(off.render(480,10.0)) is None


def test_cancelling_from_a_time_keeps_what_comes_before_it():
    m=mixer();m.post('event',10.001,'click',{});m.post('event',10.5,'click',{});m.post('cancel',10.2)
    m.render(480,10.0);
    for i in range(1,60):m.render(480,10+i*.01)
    assert m.played==1


def test_cancelling_everything_stops_the_cue_with_a_fade_not_a_cut():
    track=(np.ones((RATE,2))*8000).astype(np.int16)
    m=mixer();m.post('track','s',track);m.post('event',10.0,'cue',{'song':'s','source':0,'speed':1})
    m.render(4800,10.0)
    m.post('cancel',None)
    out=m.render(4800,10.1)
    assert abs(out[0,0])>0.05 and out[-1,0]==0            # fades down, then silence
    assert np.all(np.diff(out[:,0])<=1e-6)


def cue_ramp(seconds=4):
    """Each sample says where in the file it is, so a test can read back the position."""
    frames=RATE*seconds
    left=(np.arange(frames)/frames*30000).astype(np.int16)
    return np.stack([left,left],axis=1)


def position_of(sample,seconds=4):return float(sample)*32768/30000*RATE*seconds


def test_the_cue_track_plays_from_the_asked_place_at_the_asked_time():
    track=cue_ramp()
    m=mixer();m.post('track','s',track);m.post('event',10.01,'cue',{'song':'s','source':1.0,'speed':1})
    first=m.render(480,10.0);assert first_sound(first) is None     # not yet
    out=m.render(480,10.01);out=m.render(480,10.02)                 # past its fade in
    assert position_of(out[0,0])==pytest.approx(RATE+480,abs=4)


def test_a_cue_started_late_catches_up_instead_of_running_behind():
    track=cue_ramp()
    m=mixer();m.post('track','s',track);m.post('event',9.9,'cue',{'song':'s','source':1.0,'speed':1})
    m.render(480,10.0);out=m.render(480,10.01)
    assert position_of(out[0,0])==pytest.approx(RATE+.1*RATE+480,abs=8)


def test_a_jump_replaces_the_cue_without_a_gap():
    track=cue_ramp()
    m=mixer();m.post('track','s',track);m.post('event',10.0,'cue',{'song':'s','source':1.0,'speed':1})
    m.render(4800,10.0)
    m.post('event',10.1,'cue',{'song':'s','source':3.0,'speed':1})
    m.render(480,10.1);out=m.render(480,10.11)
    assert position_of(out[0,0])==pytest.approx(3*RATE+480,abs=4)
    assert not m.leaving


def test_muting_the_cue_at_a_flag_leaves_it_running_in_place():
    track=cue_ramp()
    m=mixer();m.post('track','s',track);m.post('event',10.0,'cue',{'song':'s','source':1.0,'speed':1})
    m.render(480,10.0);m.post('event',10.01,'cue-off',{})
    assert first_sound(m.render(480,10.01)) is None
    m.post('event',10.02,'cue-on',{})
    out=m.render(480,10.02);out=m.render(480,10.03)
    assert position_of(out[0,0])==pytest.approx(RATE+1440,abs=4)


def test_a_track_it_doesnt_have_is_quiet_not_an_error():
    m=mixer();m.post('event',10.0,'cue',{'song':'none','source':0,'speed':1})
    assert first_sound(m.render(480,10.0)) is None


def tone(seconds,pitch):
    t=np.arange(int(RATE*seconds))/RATE
    left=(np.sin(2*np.pi*pitch*t)*12000).astype(np.int16)
    return np.stack([left,left],axis=1)


@pytest.mark.parametrize('speed',[.5,.75,1.25])
def test_at_another_speed_the_pitch_stays_and_the_place_keeps_up(speed):
    voice=CueVoice(tone(8,440),RATE,speed,RATE)
    out=np.concatenate([voice.read(480) for _ in range(200)])[RATE//10:,0]
    peak=np.abs(np.fft.rfft(out*np.hanning(len(out)))).argmax()*RATE/len(out)
    assert peak==pytest.approx(440,abs=8)
    assert voice.position==pytest.approx(RATE+96000*speed)


class FakeStream:
    def __init__(self,**kw):self.kw=kw;self.latency=.012;self.started=False;self.closed=False
    def start(self):self.started=True
    def close(self):
        # like PortAudio: closing calls the finished callback on its own thread and waits for it
        done=threading.Thread(target=self.kw['finished_callback'],daemon=True);done.start();done.join(2)
        assert not done.is_alive(),'the finished callback is stuck waiting: closing would hang forever'
        self.closed=True


class FakeSd:
    def __init__(self,fail=False):self.fail=fail;self.streams=[]
    def query_hostapis(self):return [{'name':'MME','default_output_device':0},{'name':'Windows WASAPI','default_output_device':3}]
    def query_devices(self,device):return {'name':f'Device {device}','default_samplerate':48000}
    def OutputStream(self,**kw):
        if self.fail:raise OSError('no device')
        self.streams.append(FakeStream(**kw));return self.streams[-1]


def stamp(now,ahead=.012):return SimpleNamespace(currentTime=now,outputBufferDacTime=now+ahead)


def test_it_opens_on_wasapis_default_output_only_when_it_has_something_to_play():
    sd=FakeSd();audio=MonitorAudio(backend=sd,idle_close=999)
    audio.set_gains(click=.5);assert not sd.streams
    audio.schedule([{'at':1.0,'kind':'click'}])
    assert sd.streams[0].kw['device']==3 and sd.streams[0].started
    assert audio.status()['open'] and audio.status()['device']=='Device 3'
    audio.close();assert sd.streams[0].closed


def test_it_places_sound_by_when_it_will_be_heard_not_when_the_callback_runs():
    now=[100.0];sd=FakeSd();audio=MonitorAudio(backend=sd,clock=lambda:now[0],idle_close=999)
    audio.set_gains(click=1.0);audio.schedule([])
    out=np.zeros((480,2),np.float32)
    audio._callback(out,480,stamp(now[0]),None)      # the first buffer brings the fader up; it is heard from 100.012
    audio.schedule([{'at':100.0225,'kind':'click'}])
    now[0]+=.01;audio._callback(out,480,stamp(now[0]),None)
    assert first_sound(out)==24
    audio.close()


def test_a_late_callback_doesnt_move_the_clock():
    now=[100.0];sd=FakeSd();audio=MonitorAudio(backend=sd,clock=lambda:now[0],idle_close=999)
    audio.schedule([])
    out=np.zeros((480,2),np.float32)
    audio._callback(out,480,stamp(now[0]),None);base=audio.offset
    now[0]+=.01+.008                                  # 8 ms late
    audio._callback(out,480,stamp(now[0]),None)
    assert abs(audio.offset-base)<.0001
    audio.close()


def test_no_sound_output_is_a_clear_error_and_only_that():
    audio=MonitorAudio(backend=FakeSd(fail=True),idle_close=999)
    with pytest.raises(OSError,match='sound output'):audio.schedule([{'at':1.0,'kind':'click'}])
    assert audio.status()['open'] is False


def test_nonsense_is_refused():
    audio=MonitorAudio(backend=FakeSd(),idle_close=999)
    for bad in ('x',[{'kind':'click'}],[{'at':'soon','kind':'click'}],[{'at':1,'kind':'explode'}]):
        with pytest.raises(ValueError):audio.schedule(bad)
    with pytest.raises(ValueError):audio.set_gains(click=2)
    assert not audio.backend.streams


def test_a_callback_failure_is_silence():
    now=[100.0];audio=MonitorAudio(backend=FakeSd(),clock=lambda:now[0],idle_close=999)
    audio.schedule([])
    audio.mixer.render=lambda *a:1/0
    out=np.ones((480,2),np.float32)
    audio._callback(out,480,stamp(now[0]),None)
    assert not out.any() and audio.status()['error']
    audio.close()


# ---- the cue track on disk
def wav_bytes(seconds=1):
    buffer=io.BytesIO()
    with wave.open(buffer,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(44100);w.writeframes(b'\0\0'*int(44100*seconds))
    return buffer.getvalue()


class FakeLibrary:
    def __init__(self,root):self.root=root
    def validate_song_paths(self,song_id):
        if song_id!='s1':raise KeyError('no song')
    def folder(self,song_id):
        path=self.root/song_id;path.mkdir(exist_ok=True);return path
    def contained(self,path):return path


def test_a_song_has_no_cue_track_until_you_give_it_one(tmp_path):
    store=CueTracks(FakeLibrary(tmp_path))
    assert store.get('s1') is None
    entry=store.add('s1','Call me cues.wav',wav_bytes(2))
    assert entry['name']=='Call me cues.wav' and entry['seconds']==pytest.approx(2)
    assert store.path('s1').is_file()
    assert store.get('s1')['version']==entry['version']


def test_what_isnt_audio_is_turned_away_and_changes_nothing(tmp_path):
    store=CueTracks(FakeLibrary(tmp_path))
    store.add('s1','good.wav',wav_bytes())
    with pytest.raises(ValueError,match='audio'):store.add('s1','notes.txt',b'hello')
    with pytest.raises(ValueError,match='read that'):store.add('s1','fake.wav',b'not audio at all')
    assert store.get('s1')['name']=='good.wav'


def test_replacing_or_removing_keeps_the_old_file(tmp_path):
    store=CueTracks(FakeLibrary(tmp_path))
    first=store.add('s1','one.wav',wav_bytes(1))
    second=store.add('s1','two.wav',wav_bytes(2))
    assert first['version']!=second['version']
    removed=tmp_path/'s1'/'my-cues'/'removed'
    assert len(list(removed.glob('*one*')))==0 and len(list(removed.glob('*'+first['version'])))==1
    store.remove('s1')
    assert store.get('s1') is None and len(list(removed.glob('*'+second['version'])))==1
    with pytest.raises(KeyError):store.remove('s1')


def test_a_song_zips_cue_track_only_fills_a_gap(tmp_path):
    store=CueTracks(FakeLibrary(tmp_path))
    assert store.merge('s1',{'name':'zip.wav'},wav_bytes())==(1,0)
    assert store.merge('s1',{'name':'other.wav'},wav_bytes())==(0,0)
    assert store.get('s1')['name']=='zip.wav'
    assert store.merge('s1',{'name':'bad.exe'},b'x')==(0,1)


def test_a_song_zip_carries_the_cue_track(tmp_path):
    from chordbuddy.song_extras import cue_item_from
    store=CueTracks(FakeLibrary(tmp_path))
    entry=store.add('s1','cues.wav',wav_bytes())
    folder=tmp_path/'s1'/'my-cues'
    with zipfile.ZipFile(tmp_path/'song.zip','w') as z:
        z.write(folder/'index.json','a');z.write(folder/entry['version'],'b')
    manifest={'files':[{'path':'my-cues/index.json','zip':'a'},{'path':'my-cues/'+entry['version'],'zip':'b'}]}
    with zipfile.ZipFile(tmp_path/'song.zip') as z:
        item,data=cue_item_from(z,manifest)
        assert cue_item_from(z,{'files':[]}) is None
    assert item['name']=='cues.wav' and data==wav_bytes()


def test_the_idle_timer_and_quitting_close_the_stream_without_hanging():
    now=[100.0];sd=FakeSd();audio=MonitorAudio(backend=sd,clock=lambda:now[0],idle_close=999)
    audio.schedule([]);now[0]+=2000
    with audio.lock:pass
    audio.idle_close=1;audio._close_if_idle()                 # what the idle timer does after two quiet minutes
    assert sd.streams[0].closed and not audio.status()['open']
    audio.schedule([{'at':now[0]+1,'kind':'click'}])           # the next Play opens a fresh stream
    assert len(sd.streams)==2 and audio.status()['open']
    audio.close();assert sd.streams[1].closed
    sd.streams[0].kw['finished_callback']()                    # a late call from the old stream leaves the new one alone
