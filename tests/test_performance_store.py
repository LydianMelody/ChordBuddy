import json
import sqlite3
from test_server import service,request
from test_user_midi import song,post,code

JSONH={'Content-Type':'application/json'}


def body(song_id,pid='perf1',name='Live guitar',**extra):
    return {'schema':1,'id':pid,'songId':song_id,'name':name,'grid':None,'initial':[],'cues':[],'regions':[],'jumps':[],'holds':[],**extra}


def show(sid='show1',entries=(),name='Friday VR set'):
    return {'schema':1,'id':sid,'name':name,'entries':list(entries)}


def save(service,value,base=0):
    return post(service,'/api/performance/save',{'body':value,'base':base})


def test_a_save_makes_a_revision_that_never_changes(service,song):
    one=save(service,body(song,cues=[{'id':'a'}]))
    assert one['head']==1 and one['revision']==1 and one['body']['cues']==[{'id':'a'}]
    two=save(service,body(song,cues=[{'id':'b'}]),base=1)
    assert two['head']==2
    assert json.load(request(service,'/api/performance/perf1?revision=1'))['body']['cues']==[{'id':'a'}]
    assert json.load(request(service,'/api/performance/perf1'))['body']['cues']==[{'id':'b'}]
    assert [p['name'] for p in json.load(request(service,'/api/performances/'+song))]==['Live guitar']


def test_saving_over_a_newer_revision_is_refused_and_nothing_changes(service,song):
    save(service,body(song));save(service,body(song,name='Second'),base=1)
    assert code(service,'/api/performance/save',json.dumps({'body':body(song,name='Stale'),'base':1}).encode(),JSONH)==409
    assert json.load(request(service,'/api/performance/perf1'))['name']=='Second'
    assert json.load(request(service,'/api/performance/perf1'))['head']==2


def test_a_draft_sits_on_its_revision_and_a_save_clears_it(service,song):
    save(service,body(song))
    assert post(service,'/api/performance/draft',{'body':body(song,name='Working'),'base':1})=={'saved':True,'base':1}
    record=json.load(request(service,'/api/performance/perf1'))
    assert record['draft']['name']=='Working' and record['body']['name']=='Live guitar' and record['draft_base']==1
    assert json.load(request(service,'/api/performances/'+song))[0]['has_draft'] is True
    save(service,body(song,name='Working'),base=1)
    assert json.load(request(service,'/api/performance/perf1'))['draft'] is None


def test_a_failed_save_rolls_back(service,song):
    bad=body('nosuchsong0','perf9')
    assert code(service,'/api/performance/save',json.dumps({'body':bad,'base':0}).encode(),JSONH)==404
    assert code(service,'/api/performance/perf9')==404


def test_bad_bodies_are_refused(service,song):
    def refused(value,base=0):
        return code(service,'/api/performance/save',json.dumps({'body':value,'base':base}).encode(),JSONH)
    assert refused(dict(body(song),schema=99))==400
    assert refused(dict(body(song),id='../../evil'))==400
    assert refused(dict(body(song),cues='nope'))==400
    assert refused(dict(body(song),name=''))==400
    assert refused(dict(body(song),cues=[{'x':'y'*(3*1024*1024)}]))==400
    deep=[];
    for _ in range(64):deep=[deep]
    assert refused(dict(body(song),cues=deep))==400
    assert refused(body(song),base=-1)==400


def test_a_performance_belongs_to_one_song(service,mp3_bytes,song):
    save(service,body(song))
    other=json.load(request(service,'/api/import?filename=Other.mp3',mp3_bytes))['id']
    assert code(service,'/api/performance/save',json.dumps({'body':body(other),'base':1}).encode(),JSONH)==400


def test_a_show_pins_revisions_and_a_song_can_appear_twice(service,song):
    save(service,body(song));save(service,body(song,name='Newer'),base=1)
    entries=[{'id':'e1','songId':song,'performanceId':'perf1','revision':1},{'id':'e2','songId':song,'performanceId':'perf1','revision':2},{'id':'e3','songId':song,'performanceId':None}]
    saved=post(service,'/api/show/save',{'body':show(entries=entries),'base':0})
    assert [e['id'] for e in saved['body']['entries']]==['e1','e2','e3']
    assert json.load(request(service,'/api/performance/perf1?revision=1'))['body']['name']=='Live guitar'
    assert [s['name'] for s in json.load(request(service,'/api/shows'))]==['Friday VR set']
    assert post(service,'/api/show/save',{'body':show(name='Renamed',entries=entries),'base':1})['head']==2
    assert code(service,'/api/show/save',json.dumps({'body':show(entries=entries),'base':1}).encode(),JSONH)==409


def test_a_show_cannot_name_something_that_is_not_there(service,song,mp3_bytes):
    save(service,body(song))
    def refused(entries):
        return code(service,'/api/show/save',json.dumps({'body':show(entries=entries),'base':0}).encode(),JSONH)
    assert refused([{'id':'e','songId':song,'performanceId':'perf1','revision':7}])==400
    assert refused([{'id':'e','songId':song,'performanceId':'perf1'}])==400
    assert refused([{'id':'e','songId':song,'performanceId':None},{'id':'e','songId':song,'performanceId':None}])==400
    other=json.load(request(service,'/api/import?filename=Other.mp3',mp3_bytes))['id']
    assert refused([{'id':'e','songId':other,'performanceId':'perf1','revision':1}])==400
    assert code(service,'/api/show/nosuchshow')==404


def test_deleting_hides_a_performance_but_a_pinned_revision_still_resolves(service,song):
    save(service,body(song))
    post(service,'/api/show/save',{'body':show(entries=[{'id':'e','songId':song,'performanceId':'perf1','revision':1}]),'base':0})
    assert post(service,'/api/performance/delete',{'id':'perf1'})=={'deleted':True}
    assert json.load(request(service,'/api/performances/'+song))==[]
    assert json.load(request(service,'/api/performance/perf1?revision=1'))['deleted'] is True
    assert code(service,'/api/performance/save',json.dumps({'body':body(song),'base':1}).encode(),JSONH)==409
    assert post(service,'/api/show/delete',{'id':'show1'})=={'deleted':True}
    assert json.load(request(service,'/api/shows'))==[]


def test_old_libraries_gain_the_tables_and_keep_everything(service,song):
    saved=sqlite3.connect(service.app.library.root/'library.sqlite3')
    tables={r[0] for r in saved.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {'performances','performance_revisions','shows','show_revisions','songs','memberships'}<=tables
    saved.close()
    assert json.load(request(service,'/api/state'))['songs'][0]['id']==song


def test_saved_values_survive_a_restart(service,song,tmp_path):
    from chordbuddy.performance_store import PerformanceStore
    save(service,body(song,cues=[{'id':'z'}]))
    again=PerformanceStore(service.app.library)
    assert again.performance('perf1')['body']['cues']==[{'id':'z'}]
