"""The sound only the player hears: the metronome, count-ins and a song's cue track. It plays from this Python process, on its own stream to the same
output as the music. OBS's Application Audio Capture listens to the WebView2 that plays the music (the "Chord Buddy sound for OBS" window), so nothing
played here reaches the stream.

The page decides what happens and when, on the same clock as live MIDI (`clock`, seconds), and sends a moment ahead. Everything is placed to the sample in
the stream's own callback, which owns all the mixing state: other threads only leave messages for it, so a slow request can never hold up the sound.
This never touches the music, and if it can't play, the music carries on without it.
"""
from __future__ import annotations
import heapq
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np

FADE=.005                 # seconds of fade whenever the cue track starts, stops or jumps, so none of those clicks
LATE_OK=.03               # a click this late still plays; any later and it would be off the beat, so it is left out
SETTLE=.002               # how fast the frame clock follows the callbacks' timing, per callback: slowly, so one late callback moves nothing
MAX_QUEUE=4000
MAX_TRACKS=2              # the song playing and the next one in a set list
IDLE_CLOSE=120.0          # with nothing to play for this long, the stream closes and Windows can let the headset sleep
EVENT_KINDS=('click','cue','cue-stop','cue-on','cue-off')


def click_sound(rate,pitch):
    """A short, dry tick."""
    t=np.arange(int(rate*.03))/rate
    return (np.sin(2*np.pi*pitch*t)*np.exp(-t/.006)).astype(np.float32)


class CueVoice:
    """One stretch of the cue track. Its place in the file always follows the song exactly. At another speed it reads overlapping grains, each lined up with
    the last, so the pitch stays put; that is a simple way to stretch, and a voice sounds a little rough far from 100%."""
    def __init__(self,data,position,speed,rate):
        self.data=data;self.position=float(position);self.speed=float(speed)
        self.fade_step=1/max(1,int(FADE*rate));self.level=0.0;self.goal=1.0
        self.grain=max(256,int(rate*.04))&~1;self.window=np.hanning(self.grain).astype(np.float32)[:,None]
        self.search=int(rate*.008);self.held=np.zeros((self.grain,2),np.float32);self.ready=0;self.last=None;self.grain_at=self.position

    def _slice(self,at,count):
        out=np.zeros((count,2),np.float32);at=int(at)
        if at<0:skip=min(count,-at);at=0
        else:skip=0
        part=self.data[at:at+count-skip]
        if len(part):out[skip:skip+len(part)]=part.astype(np.float32)/32768
        return out

    def _next_grain(self):
        at=int(self.grain_at);hop=self.grain//2
        if self.last is not None and 0<=at-self.search and at+self.grain+self.search<len(self.data):
            want=self.data[self.last+hop:self.last+hop+hop].mean(axis=1,dtype=np.float32)
            near=self.data[at-self.search:at+self.search+hop].mean(axis=1,dtype=np.float32)
            if len(want)==hop:at+=int(np.argmax(np.correlate(near,want,'valid')))-self.search
        grain=self._slice(at,self.grain)*self.window
        self.last=at;self.grain_at+=hop*self.speed
        self.held[:self.grain]+=grain;self.ready+=hop

    def _stretched(self,count):
        hop=self.grain//2;out=np.zeros((count,2),np.float32);done=0
        while done<count:
            if not self.ready:
                if done==0 and self.last is None:self.grain_at=self.position
                self._next_grain()
            n=min(count-done,self.ready);out[done:done+n]=self.held[:n]
            self.held=np.concatenate((self.held[n:],np.zeros((n,2),np.float32)));self.ready-=n;done+=n
        self.position+=count*self.speed
        return out

    def read(self,count):
        if abs(self.speed-1)<1e-4:
            out=self._slice(self.position,count);self.position+=count
        else:out=self._stretched(count)
        if self.level!=self.goal:
            step=self.fade_step if self.goal>self.level else -self.fade_step
            ramp=np.clip(self.level+step*np.arange(1,count+1,dtype=np.float32),0,1)
            out*=ramp[:,None];self.level=float(ramp[-1])
        elif self.level==0:out[:]=0
        return out

    @property
    def silent(self):return self.goal==0 and self.level==0


class MonitorMixer:
    """Everything that sounds, placed by clock time. No clock or device of its own, so it can be tested a buffer at a time."""
    def __init__(self,rate):
        self.rate=rate;self.inbox=deque();self.queue=[];self.sequence=0;self.tracks={}
        self.sounds={False:click_sound(rate,1500),True:click_sound(rate,2400)}
        self.clicks=[];self.cue=None;self.leaving=[];self.cue_on=True
        self.goal={'click':0.0,'cue':0.0};self.gain={'click':0.0,'cue':0.0}
        self.late=0;self.missed=0;self.played=0

    def post(self,*message):self.inbox.append(message)

    def _drain(self):
        while self.inbox:
            kind,*rest=self.inbox.popleft()
            if kind=='event':
                self.sequence+=1;heapq.heappush(self.queue,(rest[0],self.sequence,rest[1],rest[2]))
            elif kind=='cancel':
                start=rest[0]
                self.queue=[e for e in self.queue if start is not None and e[0]<start];heapq.heapify(self.queue)
                if start is None:self._stop_cue();self.clicks=[];self.cue_on=True
            elif kind=='gain':self.goal[rest[0]]=rest[1]
            elif kind=='track':
                self.tracks.pop(rest[0],None)
                if rest[1] is not None:self.tracks[rest[0]]=rest[1]
                while len(self.tracks)>MAX_TRACKS:self.tracks.pop(next(iter(self.tracks)))

    def _stop_cue(self):
        if self.cue is not None:self.cue.goal=0.0;self.leaving.append(self.cue);self.cue=None

    def _apply(self,at,kind,data,now):
        late=now-at
        if kind=='click':
            if late>LATE_OK:self.missed+=1;return
            if late>.001:self.late+=1
            self.played+=1;self.clicks.append([self.sounds[bool(data.get('accent'))],0]);return
        if kind=='cue':
            track=self.tracks.get(data.get('song'))
            self._stop_cue()
            if track is None:return
            speed=float(data.get('speed',1));position=float(data.get('source',0))*self.rate+max(0.0,late)*self.rate*speed
            self.cue=CueVoice(track,position,speed,self.rate)
        elif kind=='cue-stop':self._stop_cue()
        elif kind=='cue-on':self.cue_on=True
        elif kind=='cue-off':self.cue_on=False

    def _span(self,clicks,cue,start,end):
        count=end-start
        if count<=0:return
        for voice in self.clicks:
            sound,at=voice;part=sound[at:at+count]
            clicks[start:start+len(part)]+=part[:,None];voice[1]=at+count
        self.clicks=[v for v in self.clicks if v[1]<len(v[0])]
        for voice in ([self.cue] if self.cue else [])+self.leaving:
            sound=voice.read(count)
            if self.cue_on:cue[start:end]+=sound
        self.leaving=[v for v in self.leaving if not v.silent]

    def render(self,count,t0):
        """count frames, stereo, the first of them heard at clock time t0."""
        self._drain()
        clicks=np.zeros((count,2),np.float32);cue=np.zeros((count,2),np.float32)
        end=t0+count/self.rate;at=0
        while self.queue and self.queue[0][0]<end:
            when,_,kind,data=heapq.heappop(self.queue)
            place=min(count,max(0,int(round((when-t0)*self.rate))))
            self._span(clicks,cue,at,place);at=max(at,place)
            self._apply(when,kind,data,t0+at/self.rate)
        self._span(clicks,cue,at,count)
        out=clicks*self._level('click',count)+cue*self._level('cue',count)
        return np.clip(out,-1,1)

    def _level(self,part,count):
        """A fader's move, spread over one buffer: too fast to hear as a move, too slow to click."""
        was,now=self.gain[part],self.goal[part];self.gain[part]=now
        return now if was==now else np.linspace(was,now,count,dtype=np.float32)[:,None]


class MonitorAudio:
    """The stream, and what the app asks of it. backend: the sounddevice module, or a stand-in for tests."""
    def __init__(self,project=None,backend=None,clock=time.perf_counter,idle_close=IDLE_CLOSE):
        self.project=Path(project) if project else None
        self._backend=backend;self.clock=clock;self.idle_close=idle_close
        self.shutting=threading.Lock()   # held while a stream closes; the finished callback takes no lock at all
        self.lock=threading.RLock();self.stream=None;self.mixer=None;self.rate=None
        self.frame=0;self.offset=None;self.underflows=0;self.error=None;self.last_used=clock();self.watch=None;self.closed=False
        self.gains={'click':0.0,'cue':0.0};self.loaded={};self.device=None

    @property
    def backend(self):
        if self._backend is None:
            import sounddevice
            self._backend=sounddevice
        return self._backend

    def available(self):
        try:self.backend
        except Exception as exc:return {'available':False,'reason':f'The sound library for the click isn’t installed: {exc}'}
        return {'available':True,'reason':None}

    def _pick_device(self,sd):
        for api in sd.query_hostapis():
            if 'WASAPI' in api['name'] and api['default_output_device']>=0:return api['default_output_device']
        return sd.default.device[1]

    def _open(self):
        """Opens the stream on what Windows has as the default output now, the same place the music goes."""
        with self.shutting,self.lock:          # never while an old stream is still closing: opening restarts the sound library
            if self.stream is not None:return
            sd=self.backend
            try:
                # a headset unplugged since last time: the device list is only read when the library starts
                if hasattr(sd,'_terminate'):sd._terminate();sd._initialize()
                device=self._pick_device(sd);info=sd.query_devices(device);rate=int(info['default_samplerate'])
                made=[]
                stream=sd.OutputStream(device=device,samplerate=rate,channels=2,dtype='float32',blocksize=max(64,rate//100),latency='low',
                                       callback=self._callback,finished_callback=lambda:self._finished(made[0] if made else None))
                made.append(stream)
            except Exception as exc:
                self.error=str(exc);raise OSError(f'The click couldn’t open the sound output: {exc}') from exc
            if self.rate!=rate:self.loaded={}
            self.rate=rate;self.device=info.get('name');self.mixer=MonitorMixer(rate);self.frame=0;self.offset=None;self.error=None;self.stream=stream
            for part,value in self.gains.items():self.mixer.post('gain',part,value)
            for song,track in self.loaded.items():self.mixer.post('track',song,track)
            stream.start()
            if self.watch is None:
                self.watch=threading.Thread(target=self._watch,name='monitor-idle',daemon=True);self.watch.start()

    def _callback(self,outdata,frames,time_info,status):
        try:
            if status and getattr(status,'output_underflow',False):self.underflows+=1
            now=self.clock()
            ahead=time_info.outputBufferDacTime-time_info.currentTime
            if not 0<ahead<1:ahead=self.stream.latency if self.stream else 0.02
            estimate=now+ahead-self.frame/self.rate
            if self.offset is None:self.offset=estimate
            else:self.offset+=(estimate-self.offset)*(.1 if estimate<self.offset else SETTLE)   # a callback can only be late, never early
            outdata[:]=self.mixer.render(frames,self.offset+self.frame/self.rate)
            self.frame+=frames
        except Exception as exc:
            self.error=str(exc);outdata[:]=0

    def _finished(self,stream):
        # PortAudio calls this from inside stream.close(), on its own thread, so it must never wait for the lock: that was a hang
        # (closing held the lock and waited for this). It only forgets a stream that ended by itself, never a newer one.
        if stream is not None and self.stream is stream:self.stream=None

    def _watch(self):
        while not self.closed:
            time.sleep(min(5.0,self.idle_close))
            self._close_if_idle()

    def _close_if_idle(self):
        with self.lock:
            stream=self._take_stream() if self.stream is not None and self.clock()-self.last_used>self.idle_close else None
        self._shut(stream)

    def _take_stream(self):
        stream,self.stream=self.stream,None
        return stream

    def _shut(self,stream):
        """Closes a stream already taken off this object. Always outside the lock: closing waits for PortAudio's finished callback."""
        if stream is not None:
            with self.shutting:
                try:stream.close()
                except Exception:pass

    def status(self):
        with self.lock:
            mixer=self.mixer
            return {**self.available(),'clock':self.clock(),'open':self.stream is not None,'device':self.device,'rate':self.rate,'latency':getattr(self.stream,'latency',None),
                    'played':mixer.played if mixer else 0,'late':mixer.late if mixer else 0,'missed':mixer.missed if mixer else 0,
                    'underflows':self.underflows,'error':self.error,'tracks':list(self.loaded)}

    def schedule(self,events):
        """events: [{'at': seconds on this clock, 'kind': click, cue, cue-stop, cue-on or cue-off, ...}]. Opens the stream if it needs to."""
        if not isinstance(events,list) or len(events)>MAX_QUEUE:raise ValueError('Those monitor sounds aren’t valid.')
        for event in events:
            if not isinstance(event,dict) or type(event.get('at')) not in (int,float) or event.get('kind') not in EVENT_KINDS:raise ValueError('Those monitor sounds aren’t valid.')
        self.last_used=self.clock()
        self._open()
        for event in events:self.mixer.post('event',float(event['at']),event['kind'],event)
        return {'queued':len(events)}

    def cancel(self,start=None):
        """Take back what hasn't sounded: from a time on, or, with no time, everything, and stop what's sounding (pause, a jump, the end of a show)."""
        if start is not None and type(start) not in (int,float):raise ValueError('That isn’t a time.')
        if self.mixer is not None:self.mixer.post('cancel',start)
        return {'ok':True}

    def set_gains(self,click=None,cue=None):
        for part,value in (('click',click),('cue',cue)):
            if value is None:continue
            if type(value) not in (int,float) or not 0<=value<=1:raise ValueError('A level must be between 0 and 1.')
            self.gains[part]=float(value)
            if self.mixer is not None:self.mixer.post('gain',part,float(value))
        return {'ok':True}

    def load_track(self,key,path):
        """A cue track, decoded to the output's sample rate and held in memory, ready to start the moment the music does. key names this version of the track."""
        self.last_used=self.clock();self._open()
        if key in self.loaded:return {'ready':True}
        ffmpeg=(self.project/'tools/ffmpeg.exe') if self.project else None
        if ffmpeg is None or not ffmpeg.is_file():raise OSError('The audio decoder (tools/ffmpeg.exe) is missing')
        run=subprocess.run([str(ffmpeg),'-nostdin','-v','error','-i',str(path),'-vn','-ar',str(self.rate),'-ac','2','-f','s16le','pipe:1'],
                           capture_output=True,timeout=120,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if run.returncode or not run.stdout:raise ValueError('Chord Buddy couldn’t read that audio file.')
        track=np.frombuffer(run.stdout,dtype=np.int16).reshape(-1,2)
        with self.lock:
            self.loaded[key]=track
            while len(self.loaded)>MAX_TRACKS:self.loaded.pop(next(iter(self.loaded)))
            self.mixer.post('track',key,track)
        return {'ready':True}

    def close(self):
        self.closed=True
        with self.lock:stream=self._take_stream()
        self._shut(stream)
