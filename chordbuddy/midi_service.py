from __future__ import annotations
import heapq
import re
import threading
import time
from collections import deque

MAX_QUEUE=20000
MAX_LOG=2000
MAX_EVENTS=2000
SPIN=0.002                                      # the last 2 ms before a send are spent watching the clock, not sleeping
SUFFIX=re.compile(r'\s+\d+$')


def logical_name(port):
    """Windows numbers ports by when they appeared ("Line 6 Helix 1"), so a saved binding keeps the name without the number."""
    return SUFFIX.sub('',port)


def valid_bytes(message):
    if not isinstance(message,list) or not 1<=len(message)<=3:return False
    if not all(type(b) is int and 0<=b<=255 for b in message):return False
    return message[0]>=0x80 and all(b<0x80 for b in message[1:])


class RtMidiBackend:
    """The real ports. Imported on first use, so the app runs where rtmidi is missing."""
    def __init__(self):
        import rtmidi
        self.rtmidi=rtmidi

    def inputs(self):return self.rtmidi.MidiIn().get_ports()

    def outputs(self):return self.rtmidi.MidiOut().get_ports()

    def open_output(self,port):
        out=self.rtmidi.MidiOut();out.open_port(out.get_ports().index(port));return out

    def open_input(self,port,callback):
        midi=self.rtmidi.MidiIn();midi.ignore_types(sysex=True,timing=True,active_sense=True)
        midi.open_port(midi.get_ports().index(port));midi.set_callback(lambda event,data=None:callback(event[0]));return midi


class MidiService:
    """Live MIDI for a performance. A scheduling thread sends each message at its time on one clock that never jumps (`clock`, seconds); the page
    asks that clock's time and sends ahead. Input goes straight into a bounded list the page reads, so a slow page can never hold up a callback.
    A successful send means it was sent, not that the device did anything. Messages are bounded and checked; only short channel messages go out."""
    def __init__(self,backend=None,clock=time.perf_counter,sleep=time.sleep,autostart=True):
        self._backend=backend;self.clock=clock;self.sleep=sleep
        self.lock=threading.Condition()
        self.queue=[];self.sequence=0;self.outputs={};self.inputs={};self.notes={}
        self.log=deque(maxlen=MAX_LOG);self.events=deque(maxlen=MAX_EVENTS);self.event_id=0;self.missed=0;self.lateness=deque(maxlen=20000)
        self.closed=False;self.thread=None;self.autostart=autostart

    @property
    def backend(self):
        if self._backend is None:self._backend=RtMidiBackend()
        return self._backend

    def available(self):
        try:self.backend
        except Exception as exc:return {'available':False,'reason':f'Live MIDI isn’t installed: {exc}'}
        return {'available':True,'reason':None}

    def ports(self):
        status=self.available()
        if not status['available']:return {**status,'inputs':[],'outputs':[]}
        return {**status,'inputs':[{'port':p,'name':logical_name(p),'open':logical_name(p) in self.inputs} for p in self.backend.inputs()],
                'outputs':[{'port':p,'name':logical_name(p),'open':logical_name(p) in self.outputs} for p in self.backend.outputs()]}

    def _find(self,ports,name):
        same=[p for p in ports if logical_name(p)==name]
        return same[0] if len(same)==1 else None       # never guess between two with one name, or pick a different pedal with a similar one

    def connect(self,name,*,output=True,input=True):
        """Open a device by its name, output and input. Says which opened and why not: another program may be holding a port."""
        if not isinstance(name,str) or not name or len(name)>200:raise ValueError('Choose a MIDI device.')
        result={'name':name,'output':False,'input':False,'error':None}
        with self.lock:
            try:
                if output and name not in self.outputs:
                    port=self._find(self.backend.outputs(),name)
                    if port:self.outputs[name]=self.backend.open_output(port)
                result['output']=name in self.outputs
                if input and name not in self.inputs:
                    port=self._find(self.backend.inputs(),name)
                    if port:self.inputs[name]=self.backend.open_input(port,lambda message,device=name:self._received(device,message))
                result['input']=name in self.inputs
            except Exception as exc:
                result['error']=f'Windows wouldn’t open this device. Another program may be using it. ({exc})'
        self._note('connect',name=name,output=result['output'],input=result['input'],error=result['error'])
        return result

    def disconnect(self,name):
        with self.lock:
            self._release_notes(name,self.clock())
            for table in (self.outputs,self.inputs):
                port=table.pop(name,None)
                if port is not None:
                    try:port.close_port()
                    except Exception:pass
        return {'name':name,'output':False,'input':False}

    def status(self):
        with self.lock:
            seen=sorted(self.lateness)
            pick=lambda f:seen[min(len(seen)-1,int(len(seen)*f))] if seen else None
            return {'clock':self.clock(),'outputs':sorted(self.outputs),'inputs':sorted(self.inputs),'queued':len(self.queue),'missed':self.missed,
                    'late_ms':{'p50':pick(.5),'p95':pick(.95),'p99':pick(.99),'max':seen[-1] if seen else None,'count':len(seen)}}

    def _note(self,kind,**details):
        self.log.append({'t':self.clock(),'kind':kind,**details})

    def _received(self,device,message):
        with self.lock:
            self.event_id+=1
            self.events.append({'id':self.event_id,'device':device,'bytes':list(message),'t':self.clock()})
            self.lock.notify_all()

    def read_events(self,after=0,wait=0.0):
        """Input since event `after`. wait: seconds to hold the request open for the next one."""
        deadline=self.clock()+min(float(wait),5.0)
        with self.lock:
            while not self.closed:
                new=[e for e in self.events if e['id']>after]
                if new or self.clock()>=deadline:return {'events':new,'last':self.event_id}
                self.lock.wait(max(0.0,min(deadline-self.clock(),0.25)))
        return {'events':[],'last':self.event_id}

    def schedule(self,device,events,generation=0):
        """events: [{'at': seconds on this clock, 'bytes': [...], 'id'?, 'note_off_at'?}]. Late ones go at once, and are counted."""
        if not isinstance(events,list):raise ValueError('MIDI events must be a list.')
        for event in events:
            if not isinstance(event,dict) or type(event.get('at')) not in (int,float) or not valid_bytes(event.get('bytes')):raise ValueError('That MIDI message isn’t valid.')
        with self.lock:
            if len(self.queue)+len(events)>MAX_QUEUE:raise ValueError('Too many MIDI messages are waiting.')
            for event in events:
                self.sequence+=1
                heapq.heappush(self.queue,(float(event['at']),self.sequence,device,list(event['bytes']),generation,event.get('id')))
            if self.thread is None and self.autostart:
                self.thread=threading.Thread(target=self._run,name='midi-scheduler',daemon=True);self.thread.start()
            self.lock.notify_all()
        return {'queued':len(events)}

    def cancel(self,device=None,start=None,generation=None):
        """Take back what hasn't gone out: from a time on, or an old generation. What has been sent can't be unsent."""
        with self.lock:
            keep=[item for item in self.queue if not ((device is None or item[2]==device) and (start is None or item[0]>=start) and (generation is None or item[4]==generation))]
            removed=len(self.queue)-len(keep)
            heapq.heapify(keep);self.queue=keep;self.lock.notify_all()
        return {'cancelled':removed}

    def cleanup(self,device=None):
        """Turn off every note this app started. Other channels, and other programs' notes, are left alone."""
        with self.lock:
            now=self.clock()
            self.queue=[item for item in self.queue if not (device is None or item[2]==device)]
            heapq.heapify(self.queue)
            for name in list(self.notes if device is None else [device]):self._release_notes(name,now)
        return {'ok':True}

    def _release_notes(self,device,now):
        out=self.outputs.get(device)
        for channel,note in list(self.notes.get(device,())):
            if out is not None:self._write(device,out,[0x80|channel,note,0],now,now)
        self.notes.pop(device,None)

    def _write(self,device,out,message,due,now):
        status=message[0]&0xF0
        if status==0x90 and len(message)==3 and message[2]>0:self.notes.setdefault(device,set()).add((message[0]&0x0F,message[1]))
        elif status==0x80 or (status==0x90 and len(message)==3 and message[2]==0):self.notes.get(device,set()).discard((message[0]&0x0F,message[1]))
        try:out.send_message(message)
        except Exception as exc:
            self.missed+=1;self._note('send-failed',device=device,bytes=message,error=str(exc));return False
        self._note('tx',device=device,bytes=message,due=due,sent=now)
        return True

    def run_once(self):
        """Sends what's due. Returns seconds until the next message, or None. Holds the lock only for the send."""
        with self.lock:
            if not self.queue:return None
            at=self.queue[0][0];now=self.clock()
            if at>now:return at-now
            at,_,device,message,_,_=heapq.heappop(self.queue)
            out=self.outputs.get(device)
            if out is None:
                self.missed+=1;self._note('missed',device=device,bytes=message,due=at)    # a device gone: noted, never saved up to flood it later
                return 0.0
            self.lateness.append((now-at)*1000)
            self._write(device,out,message,at,now)
            return 0.0

    def _run(self):
        while True:
            with self.lock:
                if self.closed:return
                if not self.queue:self.lock.wait(0.25);continue
            wait=self.run_once()
            if wait is None or wait<=0:continue
            if wait>SPIN:self.sleep(min(wait-SPIN,0.05))
            # within SPIN of the next message: go round again, watching the clock

    def close(self):
        with self.lock:
            self.closed=True;self.queue=[];self.lock.notify_all()
        for name in set(self.outputs)|set(self.inputs):self.disconnect(name)
