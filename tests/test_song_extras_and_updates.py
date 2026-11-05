import io
import json
import urllib.error
import zipfile
import pytest
from test_song_transfer import SONG,add_song,bring_in,export,make_app
from chordbuddy.performance_store import PerformanceStore
from chordbuddy.user_midi import UserMidi
from chordbuddy.visual_patches import VisualPatches
from chordbuddy import update_check
from test_server import service,request
from test_user_midi import post

MIDI=b'MThd'+b'\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60'+b'MTrk\x00\x00\x00\x00'
PATCH={'cables':[{'from':'song/beat','to':'pulse'}]}


def body(song,pid='a1',name='Live',cues=()):
    return {'schema':1,'id':pid,'songId':song,'name':name,'grid':None,'initial':[],'cues':list(cues),'regions':[],'jumps':[],'holds':[]}


@pytest.fixture
def pair(tmp_path):
    (tmp_path/'a').mkdir();(tmp_path/'b').mkdir()
    one,two=make_app(tmp_path/'a'),make_app(tmp_path/'b')
    add_song(one)
    return one,two


def dress(app,song=SONG):
    midi=UserMidi(app.library);entry=midi.add(song,'Lead line.mid',MIDI);midi.save_settings(song,entry['id'],{'role':'extra'})
    VisualPatches(app.library).save('abstract',PATCH,song)
    app.library.write_prefs({'cb-visual:'+song:'{"scene":"abstract"}','cb-key:'+song:'G'})
    store=PerformanceStore(app.library)
    store.save_performance(body(song,cues=[{'id':'one'}]),0);store.save_performance(body(song,cues=[{'id':'two'}]),1)
    return entry


def test_everything_about_a_song_comes_along(pair):
    one,two=pair;entry=dress(one)
    data,_=export(one)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names=archive.namelist()
        assert 'song/my-midi/index.json' in names and any(n.endswith('.mid') for n in names)
        manifest=json.loads(archive.read('chordbuddy-song.json'))
    assert manifest['version']==3 and manifest['extras']['patches']=={'abstract':PATCH}
    summary,result=bring_in(two,data)
    assert summary['extras']=={'midi':1,'patches':1,'arrangements':1}
    song=result['song_id'];assert result['extras']=={'midi':1,'patches':1,'prefs':2,'arrangements':1,'skipped':0}
    files=UserMidi(two.library).list(song)
    assert files[0]['id']==entry['id'] and files[0]['name']=='Lead line.mid' and files[0]['settings']=={'role':'extra'}
    assert UserMidi(two.library).read(song,entry['id'])==MIDI
    assert VisualPatches(two.library).read(song)['song']=={'abstract':PATCH}
    assert two.library.read_prefs()['cb-key:'+song]=='G'
    store=PerformanceStore(two.library);saved=store.performance('a1')
    assert saved['head']==2 and saved['body']['cues']==[{'id':'two'}] and store.performance('a1',1)['body']['cues']==[{'id':'one'}],'its versions too'


def test_a_song_imported_under_a_new_id_keeps_all_of_it_under_that_id(pair):
    one,_=pair;dress(one)
    data,_=export(one)
    _,result=bring_in(one,data)
    song=result['song_id'];assert song!=SONG
    assert len(UserMidi(one.library).list(song))==1
    assert VisualPatches(one.library).read(song)['song']=={'abstract':PATCH}
    assert one.library.read_prefs()['cb-key:'+song]=='G'
    arrangements=PerformanceStore(one.library).performances_for_song(song)
    assert len(arrangements)==1 and arrangements[0]['id']!='a1' and arrangements[0]['head']==2
    assert PerformanceStore(one.library).performance(arrangements[0]['id'])['body']['songId']==song
    assert len(PerformanceStore(one.library).performances_for_song(SONG))==1,'the original is untouched'


def test_updating_a_song_only_adds_and_never_overwrites_what_is_here(pair):
    one,two=pair;entry=dress(one)
    data,_=export(one)
    _,first=bring_in(two,data);song=first['song_id']
    mine={'cables':[{'from':'song/chord','to':'mine'}]}
    VisualPatches(two.library).save('abstract',mine,song)
    two.library.write_prefs({'cb-key:'+song:'A'})
    UserMidi(two.library).save_settings(song,entry['id'],{'role':'mine'})
    store=PerformanceStore(two.library);store.save_performance(body(song,cues=[{'id':'edited here'}]),2)
    _,again=bring_in(two,data,mode='update',target=song,analysis=True)
    assert VisualPatches(two.library).read(song)['song']['abstract']==mine
    assert two.library.read_prefs()['cb-key:'+song]=='A'
    assert UserMidi(two.library).list(song)[0]['settings']=={'role':'mine'} and len(UserMidi(two.library).list(song))==1
    assert store.performance('a1')['body']['cues']==[{'id':'edited here'}]
    arrangements=store.performances_for_song(song)
    assert sorted(a['name'] for a in arrangements)==['Live','Live (imported)'],'edited on both: both are kept'
    _,third=bring_in(two,data,mode='update',target=song,analysis=True)
    assert third['extras']['arrangements']==0 and len(store.performances_for_song(song))==2,'importing the same zip again adds no more copies'


def test_keeping_everything_brings_in_nothing_at_all(pair):
    one,two=pair;dress(one)
    data,_=export(one)
    _,first=bring_in(two,data);song=first['song_id']
    VisualPatches(two.library).save('abstract',None,song)
    _,kept=bring_in(two,data,mode='update',target=song)
    assert kept['changed'] is False and VisualPatches(two.library).read(song)['song']=={}


def rewrite(data,change):
    source=zipfile.ZipFile(io.BytesIO(data));out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as target:
        for info in source.infolist():
            content=source.read(info.filename)
            replaced=change(info.filename,content)
            if replaced is not None:target.writestr(info.filename,replaced)
    return out.getvalue()


def test_a_damaged_or_hostile_extra_is_left_out_and_the_song_still_comes_in(pair):
    one,two=pair;entry=dress(one)
    data,_=export(one)
    def spoil(name,content):
        if name=='song/my-midi/index.json':
            good=json.loads(content)['files'][0]
            return json.dumps({'files':[good,{'id':'../../evil','file':'../../evil.mid'},{'id':'abcdefabcdef','file':'..\\..\\evil (abcdefabcdef).mid'},'nonsense']})
        if name=='chordbuddy-song.json':
            m=json.loads(content)
            m['extras']['patches']={'abstract':{'cables':'nope'},'../bad':PATCH}
            m['extras']['prefs']={'no colon':'x','cb-key:'+SONG:'G','bad key!:'+SONG:'x'}
            m['extras']['arrangements']=[{'id':'zz','revisions':'nope'},{'revisions':[{'body':{'schema':99}}],'id':'yy'},'nonsense']
            return json.dumps(m)
        return content
    _,result=bring_in(two,rewrite(data,spoil))
    song=result['song_id']
    assert result['changed'] is True and result['extras']['skipped']>=4
    assert [f['id'] for f in UserMidi(two.library).list(song)]==[entry['id']]
    assert VisualPatches(two.library).read(song)['song']=={}
    assert PerformanceStore(two.library).performances_for_song(song)==[]
    names=[p.name for p in two.library.root.rglob('*evil*')]
    assert names==[],'nothing written outside, or under a hostile name'


def test_a_midi_file_that_is_not_midi_stays_out(pair):
    one,two=pair;dress(one)
    data,_=export(one)
    def spoil(name,content):
        return b'not midi at all, sorry' if name.endswith('.mid') else content
    _,result=bring_in(two,rewrite(data,spoil))
    assert UserMidi(two.library).list(result['song_id'])==[] and result['extras']['skipped']==1


def test_older_song_zips_without_extras_still_come_in(pair):
    one,two=pair
    data,_=export(one)
    def older(name,content):
        if name=='chordbuddy-song.json':
            m=json.loads(content);m['version']=2;m.pop('extras',None);return json.dumps(m)
        return content
    _,result=bring_in(two,rewrite(data,older))
    assert result['changed'] is True and result['extras']['midi']==0


def test_a_show_file_carries_its_visuals_and_never_overwrites(service,mp3_bytes):
    song=json.load(request(service,'/api/import?filename=Show.mp3',mp3_bytes))['id']
    cue={'id':'s','at':{'measure':'m1','beat':{'n':0,'d':1}},'action':{'type':'visual.scene','scene':'starlane'}}
    post(service,'/api/performance/save',{'body':body(song,cues=[cue]),'base':0})
    post(service,'/api/show/save',{'body':{'schema':1,'id':'show1','name':'Set','entries':[{'id':'e','songId':song,'performanceId':'a1','revision':1}]},'base':0})
    post(service,'/api/visual-patches',{'visual':'starlane','patch':PATCH})
    post(service,'/api/visual-patches',{'visual':'starlane','song_id':song,'patch':PATCH})
    post(service,'/api/visual-patches',{'visual':'unrelated','patch':PATCH})
    post(service,'/api/prefs',{'cb-visual:'+song:'{"scene":"aurora"}'})
    bundle=json.load(request(service,'/api/show/show1/export'))
    visuals=bundle['visuals']
    assert visuals['scenes']==['aurora','starlane'] and set(visuals['usual'])=={'starlane'},'only what this show uses'
    assert visuals['songs'][song]=={'starlane':PATCH} and visuals['looks'][song]=='{"scene":"aurora"}'
    assert 'function' not in json.dumps(visuals),'no visualization code travels'
    mine={'cables':[{'from':'song/chord','to':'mine'}]}
    post(service,'/api/visual-patches',{'visual':'starlane','patch':mine})
    post(service,'/api/visual-patches',{'visual':'starlane','song_id':song,'patch':None})
    result=post(service,'/api/show/import',{'bundle':bundle})
    assert result['required_scenes']==['aurora','starlane']
    now=json.load(request(service,'/api/visual-patches/'+song))
    assert now['usual']['starlane']==mine,'the usual one here stays'
    assert now['song']=={'starlane':PATCH},'a song with none gets the one from the show'


def test_a_show_file_from_before_visuals_still_imports(service,mp3_bytes):
    song=json.load(request(service,'/api/import?filename=Show.mp3',mp3_bytes))['id']
    bundle={'format':'chordbuddy-show','version':1,'songs':[{'id':song}],'performances':[],'show':{'schema':1,'id':'x','name':'Old','entries':[{'id':'e','songId':song,'performanceId':None}]}}
    result=post(service,'/api/show/import',{'bundle':bundle})
    assert result['show_id'] and result['required_scenes']==[]


# ---- updates
def answers(data):
    def fetch(url):
        fetch.url=url
        if isinstance(data,Exception):raise data
        return data
    return fetch


def test_update_check_compares_real_version_numbers():
    assert update_check.check(answers(b'0.10.0\n'),'0.9.0')['state']=='newer','0.10 is after 0.9, not before'
    assert update_check.check(answers(b'0.9.0'),'0.9.0')['state']=='current'
    assert update_check.check(answers(b'0.8.9'),'0.9.0')['state']=='current'
    assert update_check.check(answers(b'1'),'0.9.0')['state']=='newer'
    assert update_check.check(answers(b'1.0'),'1.0.0')['state']=='current'


def test_update_check_goes_only_to_the_one_address_and_says_so_when_it_cannot():
    fetch=answers(b'1.0.0');update_check.check(fetch,'0.9.0')
    assert fetch.url=='https://raw.githubusercontent.com/LydianMelody/ChordBuddy/main/VERSION'
    missing=update_check.check(answers(urllib.error.HTTPError('u',404,'gone',{},None)),'0.9.0')
    assert missing['state']=='none' and 'published' in missing['reason']
    assert update_check.check(answers(urllib.error.HTTPError('u',500,'bad',{},None)),'0.9.0')['state']=='unknown'
    assert 'internet' in update_check.check(answers(urllib.error.URLError('down')),'0.9.0')['reason']
    assert update_check.check(answers(OSError('down')),'0.9.0')['state']=='unknown'


@pytest.mark.parametrize('junk',[b'<html>hello</html>',b'1.0.0; rm -rf',b'',b'x'*65,b'\xff\xfe',b'1.2.3.4.5'])
def test_update_check_trusts_only_a_plain_version_number(junk):
    result=update_check.check(answers(junk),'0.9.0')
    assert result['state']=='unknown' and result['latest'] is None


def test_redirects_are_refused():
    assert update_check._NoRedirects().redirect_request('r','f',302,'m',{},'https://elsewhere.example') is None


def test_the_version_file_is_a_version():
    assert update_check.parse(update_check.current_version()) is not None


def test_update_routes(service,monkeypatch):
    monkeypatch.setattr(update_check,'_fetch',answers(b'99.0.0'))
    monkeypatch.setattr(update_check.check,'__defaults__',(update_check._fetch,None))
    result=json.load(request(service,'/api/update-check'))
    assert result['state']=='newer' and result['latest']=='99.0.0'
    opened=[]
    import webbrowser
    monkeypatch.setattr(webbrowser,'open',lambda url:opened.append(url))
    assert post(service,'/api/update-page',{'url':'https://evil.example'})=={'opened':True}
    assert opened==[update_check.PAGE_URL],'only ever the project’s own page, whatever is asked'
