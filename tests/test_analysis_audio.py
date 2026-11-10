import importlib.util
from pathlib import Path
import pytest

def test_prepared_audio_origin_and_preservation(ffmpeg_project):
    # The source and the prepared copy must be inside the install folder, and FFmpeg is run from its tools folder,
    # so the install folder here is the temporary one (pytest's temporary folder is not inside the real one).
    tmp_path=ffmpeg_project
    assert importlib.util.find_spec('chordbuddy.analysis_audio'), 'Canonical preparation is missing'
    from chordbuddy.analysis_audio import prepare_source
    from chordbuddy.separation_contract import file_hash
    import wave,struct
    source=tmp_path/'source.wav'
    with wave.open(str(source),'wb') as stream:
        stream.setparams((1,2,24000,0,'NONE','not compressed'))
        stream.writeframes(struct.pack('<12000h',3000,*([0]*11999)))
    digest=file_hash(source)
    result=prepare_source(tmp_path,source,tmp_path/'prepared',lambda:None)
    assert result['sample_rate']==44100 and result['channels']==2
    assert result['frames']==22050 and result['time_origin']==0
    assert result['source_sha256']==file_hash(source)==digest

def test_cancel_preparation(tmp_path):
    assert importlib.util.find_spec('chordbuddy.analysis_audio'), 'Canonical preparation is missing'
    from chordbuddy.analysis_audio import prepare_source
    def cancel(): raise RuntimeError('cancelled')
    with pytest.raises(RuntimeError,match='cancelled'):prepare_source(Path.cwd(),tmp_path/'x',tmp_path/'out',cancel)
