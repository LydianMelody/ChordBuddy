import importlib.util
import json
import os
import pytest
from chordbuddy.library import Library
from test_reprocess import seed

def store_for(tmp_path):
    assert importlib.util.find_spec('chordbuddy.analysis_store'), 'Independent stage cache is missing'
    from chordbuddy.analysis_store import AnalysisStore
    lib=Library(tmp_path); seed(lib)
    return lib,AnalysisStore(lib)

def test_source_and_asset_identity(tmp_path):
    lib,store=store_for(tmp_path)
    from chordbuddy.separation_contract import file_hash
    source=lib.source_path('song'); artifact=lib.root/'result.json';artifact.write_text('{}')
    deps={'source_sha256':file_hash(source),'recipe':{'model':'one'}}
    manifest={'assets':[{'path':'result.json','sha256':file_hash(artifact)}]}
    ref=store.publish('song','transcription',deps,manifest)
    assert store.lookup('song','transcription',deps)==ref
    assert store.lookup('song','transcription',dict(deps,recipe={'model':'two'})) is None
    artifact.write_text('[]')
    assert store.lookup('song','transcription',deps) is None
    artifact.write_text('{}');stamp=source.stat();source.write_bytes(b'other')
    os.utime(source,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
    assert store.lookup('song','transcription',deps) is None
    with pytest.raises(ValueError): store.publish('song','transcription',deps,{'assets':[{'path':'../escape','sha256':'x'}]})
    lib.close()

def test_legacy_cache_is_not_certified(tmp_path):
    lib,store=store_for(tmp_path)
    from chordbuddy.separation_contract import file_hash
    assert store.lookup('song','transcription',{'source_sha256':file_hash(lib.source_path('song'))}) is None
    lib.close()

def test_presentation_does_not_rerun_inference(tmp_path):
    lib,store=store_for(tmp_path)
    from chordbuddy.analysis_contract import transcription_dependencies
    a=transcription_dependencies('source',{'model':'fixed'}, {'device':'cpu','beat_remove_threshold':0})
    b=transcription_dependencies('source',{'model':'fixed'}, {'device':'cpu','beat_remove_threshold':99})
    assert a==b
    assert a!=transcription_dependencies('source',{'model':'changed'},{'device':'cpu'})
    lib.close()

def test_explicit_invalidation_preserves_artifacts_but_forces_new_selection(tmp_path):
    lib,store=store_for(tmp_path)
    from chordbuddy.separation_contract import file_hash
    asset=lib.root/'proposal.json';asset.write_text('{}')
    deps={'source_sha256':file_hash(lib.source_path('song'))}
    manifest={'assets':[{'path':'proposal.json','sha256':file_hash(asset)}]}
    ref=store.publish('song','rhythm',deps,manifest)
    assert hasattr(store,'invalidate'),'Explicit stage invalidation missing'
    store.invalidate('song','rhythm')
    assert store.lookup('song','rhythm',deps) is None
    assert store.manifest(ref)==manifest and asset.read_text()=='{}'
    new=store.publish('song','rhythm',deps,manifest)
    assert store.lookup('song','rhythm',deps)==new
    lib.close()
