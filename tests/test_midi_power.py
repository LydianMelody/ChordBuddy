import json
import time
import pytest
from chordbuddy.midi_service import MidiService,logical_name,valid_bytes
from chordbuddy.power_service import PowerService,ES_CONTINUOUS,ES_DISPLAY_REQUIRED,ES_SYSTEM_REQUIRED
from test_server import service,request
from test_user_midi import post,code


class FakeOut:
    def __init__(self,sent):self.sent=sent;self.closed=False
    def send_message(self,message):self.sent.append(list(message))
    def close_port(self):self.closed=True


class FakeBackend:
    def __init__(self):self.sent=[];self.callback=None;self.in_ports=['Line 6 Helix 0'];self.out_ports=['Microsoft GS Wavetable Synth 0','Line 6 Helix 1'];self.fail=False
    def inputs(self):return self.in_ports
    def outputs(self):return self.out_ports
    def open_output(self,port):
        if self.fail:raise OSError('in use')
        return FakeOut(self.sent)
    def open_input(self,port,callback):self.callback=callback;return FakeOut([])


class Clock:
    def __init__(self):self.t=100.0
    def __call__(self):return self.t


@pytest.fixture
def rig():
    backend=FakeBackend();clock=Clock()
    midi=MidiService(backend,clock=clock,autostart=False)
    midi.connect('Line 6 Helix')
    return midi,backend,clock


def drain(midi):
    while midi.run_once()==0.0:pass


def test_ports_keep_their_name_without_the_windows_number(rig):
    midi,_,_=rig
    assert logical_name('Line 6 Helix 1')=='Line 6 Helix'
    assert {p['name'] for p in midi.ports()['outputs']}=={'Microsoft GS Wavetable Synth','Line 6 Helix'}


def test_exact_bytes_go_out_in_order_at_their_time(rig):
    midi,backend,clock=rig
    midi.schedule('Line 6 Helix',[{'at':101.0,'bytes':[0xB0,69,2]},{'at':100.5,'bytes':[0xC0,4]},{'at':100.5,'bytes':[0xB0,32,1]}])
    assert midi.run_once()==pytest.approx(.5)
    assert backend.sent==[]
    clock.t=100.5;drain(midi)
    assert backend.sent==[[0xC0,4],[0xB0,32,1]],'same time: the order they were given'
    clock.t=101.0;drain(midi)
    assert backend.sent[-1]==[0xB0,69,2]


def test_lateness_is_measured(rig):
    midi,_,clock=rig
    midi.schedule('Line 6 Helix',[{'at':100.0,'bytes':[0xB0,1,1]}])
    clock.t=100.004;drain(midi)
    assert midi.status()['late_ms']['max']==pytest.approx(4,abs=.01)


def test_taking_back_what_has_not_gone_out(rig):
    midi,backend,clock=rig
    midi.schedule('Line 6 Helix',[{'at':100.1,'bytes':[0xB0,1,1]},{'at':102,'bytes':[0xB0,2,2]},{'at':103,'bytes':[0xB0,3,3]}],generation=7)
    assert midi.cancel('Line 6 Helix',start=101.5)=={'cancelled':2}
    clock.t=104;drain(midi)
    assert backend.sent==[[0xB0,1,1]]
    midi.schedule('Line 6 Helix',[{'at':105,'bytes':[0xB0,4,4]}],generation=8)
    assert midi.cancel(generation=8)=={'cancelled':1}


def test_only_notes_we_started_are_turned_off_and_only_on_their_channel(rig):
    midi,backend,clock=rig
    midi.schedule('Line 6 Helix',[{'at':100,'bytes':[0x90,60,100]},{'at':100,'bytes':[0x91,62,100]},{'at':100,'bytes':[0x90,64,100]},{'at':100,'bytes':[0x80,64,0]}])
    drain(midi)
    backend.sent.clear()
    midi.cleanup('Line 6 Helix')
    assert sorted(backend.sent)==[[0x80,60,0],[0x81,62,0]]
    backend.sent.clear();midi.cleanup('Line 6 Helix')
    assert backend.sent==[],'nothing twice, no global reset'


def test_a_missing_device_is_counted_and_never_floods_it_later(rig):
    midi,backend,clock=rig
    midi.disconnect('Line 6 Helix')
    midi.schedule('Line 6 Helix',[{'at':100,'bytes':[0xB0,1,1]},{'at':100,'bytes':[0xB0,2,2]}])
    drain(midi)
    assert midi.status()['missed']==2
    midi.connect('Line 6 Helix');drain(midi)
    assert backend.sent==[],'no backlog when it comes back'


def test_a_port_another_program_holds_says_so(rig):
    midi,backend,_=rig
    midi.disconnect('Line 6 Helix');backend.fail=True
    result=midi.connect('Line 6 Helix')
    assert result['output'] is False and 'Another program' in result['error']


def test_never_guesses_between_devices(rig):
    midi,backend,_=rig
    backend.out_ports=['Pedal 1','Pedal 2'];backend.in_ports=[]
    assert midi.connect('Pedal')['output'] is False
    assert midi.connect('Pedal Board')['output'] is False


def test_only_valid_short_messages_are_accepted(rig):
    midi,_,_=rig
    assert valid_bytes([0xF8]) and valid_bytes([0xC0,4]) and valid_bytes([0xB0,69,2])
    for bad in ([],[1,2],[0xB0,200,1],[0xB0,1,1,1],'x',[0xB0,1.5]):
        assert not valid_bytes(bad)
    with pytest.raises(ValueError):midi.schedule('Line 6 Helix',[{'at':100,'bytes':[0xF0,1,2,3]}])
    with pytest.raises(ValueError):midi.schedule('Line 6 Helix',[{'at':'soon','bytes':[0xC0,4]}])


def test_input_goes_into_a_bounded_list_with_nothing_blocking(rig):
    midi,backend,clock=rig
    backend.callback([0xB0,71,127])
    read=midi.read_events(after=0)
    assert read['events'][0]['bytes']==[0xB0,71,127] and read['events'][0]['device']=='Line 6 Helix'
    assert midi.read_events(after=read['last'])['events']==[]
    for _ in range(3000):backend.callback([0xB0,1,1])
    assert len(midi.events)==2000


def test_a_real_thread_sends_on_time_under_a_fake_port():
    backend=FakeBackend();midi=MidiService(backend);midi.connect('Line 6 Helix')
    now=midi.clock()
    midi.schedule('Line 6 Helix',[{'at':now+.05+i*.01,'bytes':[0xB0,1,i]} for i in range(10)])
    time.sleep(.3)
    assert [m[2] for m in backend.sent]==list(range(10))
    assert midi.status()['late_ms']['p99']<10,midi.status()['late_ms']
    midi.close()


def test_power_is_held_until_the_last_window_lets_go():
    calls=[];power=PowerService(call=lambda flags:calls.append(flags) or 1)
    assert power.acquire('a')['awake'] is True
    assert calls==[ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED]
    power.acquire('b')
    assert power.release('a')=={'awake':True,'holders':1},'another window still holds it'
    assert len(calls)==1
    assert power.release('b')=={'awake':False,'holders':0}
    assert calls[-1]==ES_CONTINUOUS
    power.close()


def test_power_failure_is_reported_not_hidden():
    power=PowerService(call=lambda flags:0)
    assert power.acquire('a')['awake'] is False
    power.close()
    unsupported=PowerService();unsupported.call=None
    assert unsupported.status()['supported'] is False
    assert unsupported.acquire('a')['awake'] is False


def test_all_of_it_through_the_api_on_a_fake_port(service):
    backend=FakeBackend();service.app.midi._backend=backend
    ports=json.load(request(service,'/api/midi/ports'))
    assert ports['available'] is True and ports['inputs'][0]['name']=='Line 6 Helix'
    assert post(service,'/api/midi/connect',{'name':'Line 6 Helix'})['output'] is True
    now=json.load(request(service,'/api/midi/status'))['clock']
    assert post(service,'/api/midi/schedule',{'device':'Line 6 Helix','events':[{'at':now,'bytes':[0xB0,69,2]}]})=={'queued':1}
    time.sleep(.1)
    assert backend.sent==[[0xB0,69,2]]
    backend.callback([0xB0,71,127])
    assert json.load(request(service,'/api/midi/events?after=0'))['events'][0]['bytes']==[0xB0,71,127]
    assert post(service,'/api/midi/cancel',{'device':'Line 6 Helix'})=={'cancelled':0}
    assert post(service,'/api/midi/cleanup',{'device':'Line 6 Helix'})=={'ok':True}
    assert post(service,'/api/midi/disconnect',{'name':'Line 6 Helix'})['output'] is False
    assert code(service,'/api/midi/schedule',json.dumps({'device':'x','events':[{'at':1,'bytes':[1]}]}).encode(),{'Content-Type':'application/json'})==400
    service.app.power.call=lambda flags:1
    assert post(service,'/api/power/acquire',{'holder':'show'})['awake'] is True
    assert post(service,'/api/power/release',{'holder':'show'})['awake'] is False
    assert json.load(request(service,'/api/power'))['supported'] is True


# ---- WinRT MIDI, on a stand-in for Windows
class FakeMessage:
    def __init__(self,data):self.raw_data=bytes(data)


class FakeArgs:
    def __init__(self,data):self.message=FakeMessage(data)


class FakeWinrtPort:
    def __init__(self):self.handler=None;self.closed=False;self.removed=None
    def add_message_received(self,handler):self.handler=handler;return 'token'
    def remove_message_received(self,token):self.removed=token
    def close(self):self.closed=True


class FakeWinrtApi:
    def __init__(self,names=('Line 6 Helix',),port='ok'):
        self.list=[(n,'id-'+n) for n in names];self.port=FakeWinrtPort() if port=='ok' else None;self.opened=[]
    def find(self):return self.list
    def open(self,ident):self.opened.append(ident);return self.port


class FakeMidiIn:
    ports=['Line 6 Helix 0','Other Keys 1']
    def __init__(self):self.opened=None;self.ignored=None
    def get_ports(self):return list(self.ports)
    def ignore_types(self,**kw):self.ignored=kw
    def open_port(self,i):self.opened=i
    def set_callback(self,cb):self.callback=cb


class FakeRtmidi:
    MidiIn=FakeMidiIn


def backend(api):
    from chordbuddy.midi_service import RtMidiBackend,WinrtInputs
    b=RtMidiBackend(winrt=WinrtInputs(api) if api else None)
    b.rtmidi=FakeRtmidi
    return b


def service_on(back):
    return MidiService(back,autostart=False)


def test_listening_prefers_winrt_and_offers_each_device_once():
    api=FakeWinrtApi();b=backend(api);got=[]
    assert b.inputs()==['Line 6 Helix','Other Keys 1'],'the Helix once, and what only WinMM has'
    opened=b.open_input('Line 6 Helix',got.append)
    assert api.opened==['id-Line 6 Helix'] and b.routes=={'Line 6 Helix':'winrt'}
    api.port.handler(None,FakeArgs([0xB0,20,127]))
    assert got==[[0xB0,20,127]]
    opened.close_port()
    assert api.port.removed=='token' and api.port.closed is True


def test_a_device_only_winmm_has_still_works():
    b=backend(FakeWinrtApi());got=[]
    midi=b.open_input('Other Keys 1',got.append)
    assert midi.opened==1 and b.routes['Other Keys']=='winmm'
    midi.callback(([0x90,60,100],0.0))
    assert got==[[0x90,60,100]]


def test_with_winrt_failing_or_missing_it_falls_back():
    failed=backend(FakeWinrtApi(port=None))
    assert failed.open_input('Line 6 Helix',lambda m:None).opened==0 and failed.routes['Line 6 Helix']=='winmm'
    absent=backend(None)
    assert absent.inputs()==['Line 6 Helix 0','Other Keys 1']
    class Broken(FakeWinrtApi):
        def find(self):raise OSError('no service')
    assert backend(Broken()).inputs()==['Line 6 Helix 0','Other Keys 1'],'trouble there never hides the devices'


def test_a_bad_message_from_windows_cannot_raise_on_its_thread():
    from chordbuddy.midi_service import _WinrtInput
    port=FakeWinrtPort();_WinrtInput(port,lambda m:1/0)
    port.handler(None,FakeArgs([0xB0,1,1]))
    port.handler(None,object())


def test_the_whole_service_on_winrt():
    api=FakeWinrtApi();midi=service_on(backend(api))
    assert midi.connect('Line 6 Helix',output=False)=={'name':'Line 6 Helix','output':False,'input':True,'error':None}
    api.port.handler(None,FakeArgs([0xB0,20,127]))
    assert midi.read_events()['events'][0]['bytes']==[0xB0,20,127]
    assert midi.status()['routes']=={'Line 6 Helix':'winrt'}
    midi.disconnect('Line 6 Helix')
    assert api.port.closed is True


def test_clock_proves_a_device_is_reaching_us_and_never_counts_as_a_press():
    api=FakeWinrtApi();midi=service_on(backend(api));midi.connect('Line 6 Helix',output=False)
    for _ in range(48):api.port.handler(None,FakeArgs([0xF8]))
    api.port.handler(None,FakeArgs([0xFE]));api.port.handler(None,FakeArgs([0xF0,1,0xF7]));api.port.handler(None,FakeArgs([]))
    assert midi.read_events()['events']==[],'none of those is a control'
    seen=midi.status()['clock_in']['Line 6 Helix']
    assert seen['pulses']==48 and seen['seconds_ago']<1
