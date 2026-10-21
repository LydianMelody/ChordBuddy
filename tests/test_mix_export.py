import urllib.error
import numpy as np
import pytest
from test_server import service,request
from test_separation_api import publish
from chordbuddy.mix_export import parse_levels,mix_blocks

def test_levels_are_validated():
    assert parse_levels('1,0,.5,1,1,1,1','.8')==([1,0,.5,1,1,1,1],.8)
    for bad in ('1,1','a,b,c,d,e,f,g','2,1,1,1,1,1,1','-1,1,1,1,1,1,1'):
        with pytest.raises(ValueError):parse_levels(bad,'1')
    with pytest.raises(ValueError):parse_levels('1,1,1,1,1,1,1','9')

def test_mix_is_the_weighted_sum_of_stems(service):
    run_id=publish(service.app)
    root,manifest=service.app.separation_store.get_published_run(run_id)
    def render(levels,master):
        return np.frombuffer(b''.join(mix_blocks(root,manifest,levels,master)),dtype='<f4')
    full=render([1]*7,1)
    assert len(full)==16 and np.allclose(full[0::2],.7,atol=1e-5) and np.allclose(full[1::2],-.7,atol=1e-5)
    assert np.allclose(render([1,0,0,0,0,0,0],1)[0::2],.1,atol=1e-5)          # only bass
    assert np.allclose(render([1]*7,.5)[0::2],.35,atol=1e-5)                    # master scales everything
    assert np.allclose(render([0]*7,1),0)                                         # all muted is silence
    assert np.allclose(render([1.5]*7,1.5)[0::2],1.0)                            # clipped, never wraps

def test_export_route_streams_an_mp3_and_rejects_bad_requests(service):
    run_id=publish(service.app)
    query='levels=1,1,1,0,1,1,1&master=1&name='+'No%20vocals%20%2F%20a%3Ab'
    response=request(service,f'/api/mix-export/{run_id}?{query}')
    body=response.read()
    assert response.headers['Content-Type']=='audio/mpeg'
    assert 'No%20vocals' in response.headers['Content-Disposition'] and '%2F' not in response.headers['Content-Disposition'] and '.mp3' in response.headers['Content-Disposition']
    assert body[:3]==b'ID3' or body[0]==0xFF
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/mix-export/{run_id}?levels=1,1&master=1')
    assert err.value.code==400
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/mix-export/{run_id}?{query}',headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/mix-export/nope?{query}')
    assert err.value.code in (400,404)

def test_stems_export_is_a_zip_with_one_named_mp3_per_stem(service):
    import io,zipfile
    run_id=publish(service.app)
    response=request(service,f'/api/stems-export/{run_id}?name=My%20Song')
    assert response.headers['Content-Type']=='application/zip' and 'My%20Song%20-%20stems.zip' in response.headers['Content-Disposition']
    archive=zipfile.ZipFile(io.BytesIO(response.read()))
    assert archive.testzip() is None
    assert sorted(archive.namelist())==sorted(f'My Song_{name}.mp3' for name in ('Vocals','LeadGtr','RhythmGtr','Bass','Drums','Piano','Other'))
    assert all(archive.read(name)[:3]==b'ID3' or archive.read(name)[0]==0xFF for name in archive.namelist())
    with pytest.raises(urllib.error.HTTPError) as err:request(service,f'/api/stems-export/{run_id}?name=x',headers={'X-ChordBuddy-Token':'bad'})
    assert err.value.code==403
