import json
import pytest
from test_server import service,request
from test_user_midi import song,post,code

PATCH={'cables':[{'from':'stem/drums/hit','to':'shockwave'},{'from':'mine/Keys/cc64','to':'pulse','hold':0.5,'invert':True}]}


def test_usual_and_song_patches_are_kept_apart_and_removed_on_request(service,song):
    assert json.load(request(service,'/api/visual-patches'))=={'usual':{},'song':{}}
    usual=post(service,'/api/visual-patches',{'visual':'abstract','patch':PATCH})
    assert usual=={'usual':{'abstract':PATCH},'song':{}}
    mine={'cables':[{'from':'song/beat','to':'shockwave','decay':0.4}]}
    both=post(service,'/api/visual-patches',{'visual':'abstract','song_id':song,'patch':mine})
    assert both=={'usual':{'abstract':PATCH},'song':{'abstract':mine}}
    assert json.load(request(service,'/api/visual-patches/'+song))==both
    assert json.load(request(service,'/api/visual-patches'))['song']=={}, 'without a song, no song patches'
    gone=post(service,'/api/visual-patches',{'visual':'abstract','song_id':song,'patch':None})
    assert gone=={'usual':{'abstract':PATCH},'song':{}}
    assert post(service,'/api/visual-patches',{'visual':'abstract','patch':None})['usual']=={}
    saved=json.loads((service.app.library.root/'visual-patches.json').read_text('utf-8'))
    assert saved=={'usual':{},'songs':{}}


def test_a_patch_keeps_the_inputs_it_was_saved_with_and_bad_lists_are_refused(service):
    listed={'cables':[{'from':'song/beat','to':'lasers'}],'inputs':['lasers','rings','rings']}
    assert post(service,'/api/visual-patches',{'visual':'starlane','patch':listed})['usual']['starlane']=={'cables':listed['cables'],'inputs':['lasers','rings']}
    for bad in ['rings',['../x'],[1],['ok']*65]:
        assert code(service,'/api/visual-patches',json.dumps({'visual':'starlane','patch':{'cables':[],'inputs':bad}}).encode(),{'Content-Type':'application/json'})==400


def test_an_empty_patch_is_kept_since_everything_unplugged_is_a_choice(service):
    assert post(service,'/api/visual-patches',{'visual':'starlane','patch':{'cables':[]}})['usual']=={'starlane':{'cables':[]}}


@pytest.mark.parametrize('body',[
    {'visual':'../evil','patch':PATCH},
    {'visual':'abstract','patch':{'cables':'no'}},
    {'visual':'abstract','patch':{'cables':[{'from':'','to':'x'}]}},
    {'visual':'abstract','patch':{'cables':[{'from':'a','to':'x','decay':'slow'}]}},
    {'visual':'abstract','patch':{'cables':[{'from':'a','to':'x','invert':1}]}},
    {'visual':'abstract','patch':{'cables':[{'from':'a','to':'x'}]*65}},
])
def test_bad_patches_are_refused_and_nothing_is_saved(service,body):
    assert code(service,'/api/visual-patches',json.dumps(body).encode(),{'Content-Type':'application/json'})==400
    assert json.load(request(service,'/api/visual-patches'))['usual']=={}


def test_unknown_settings_are_dropped_and_unknown_songs_refused(service):
    saved=post(service,'/api/visual-patches',{'visual':'abstract','patch':{'cables':[{'from':'a','to':'x','evil':'<script>','smooth':0.2}]}})
    assert saved['usual']['abstract']=={'cables':[{'from':'a','to':'x','smooth':0.2}]}
    assert code(service,'/api/visual-patches/notasong')>=400
    assert code(service,'/api/visual-patches',json.dumps({'visual':'abstract','song_id':'notasong','patch':PATCH}).encode(),{'Content-Type':'application/json'})>=400


def test_a_measured_range_is_kept_and_a_bad_one_refused(service):
    fitted={'cables':[{'from':'mine/Keys/cc1','to':'spin','fit':[0.2,0.6]}]}
    assert post(service,'/api/visual-patches',{'visual':'abstract','patch':fitted})['usual']['abstract']==fitted
    notes={'cables':[{'from':'mine/Keys/notes','to':'comet','fit':[48,72],'outside':'clip'}]}
    assert post(service,'/api/visual-patches',{'visual':'abstract','patch':notes})['usual']['abstract']==notes
    body=json.dumps({'visual':'abstract','patch':{'cables':[{'from':'a','to':'x','outside':'sideways'}]}}).encode()
    assert code(service,'/api/visual-patches',body,{'Content-Type':'application/json'})==400
    for bad in ([0.6,0.2],[0,200],'wide',[0.1]):
        body=json.dumps({'visual':'abstract','patch':{'cables':[{'from':'a','to':'x','fit':bad}]}}).encode()
        assert code(service,'/api/visual-patches',body,{'Content-Type':'application/json'})==400


def test_a_damaged_file_reads_as_no_patches(service):
    (service.app.library.root/'visual-patches.json').write_text('{not json','utf-8')
    assert json.load(request(service,'/api/visual-patches'))=={'usual':{},'song':{}}
