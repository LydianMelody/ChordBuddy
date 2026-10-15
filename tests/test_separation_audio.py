import array
import struct
import pytest
from chordbuddy.separation_audio import write_float, index_wav, read_frames, validate_mix, wire_chunk
from chordbuddy.separation_contract import TRACKS

def test_float_wav_roundtrip_and_bounded_read(tmp_path):
    p=tmp_path/'audio.wav'; write_float(p,[.1,-.1,.2,-.2,.3,-.3])
    info=index_wav(p)
    assert info['frames']==3
    assert list(read_frames(p,info,1,1))==pytest.approx([.2,-.2])
    with pytest.raises(ValueError): read_frames(p,info,-1,2)
    with pytest.raises(ValueError): read_frames(p,info,0,44101)

def test_nonfinite_and_truncated_wave_rejected(tmp_path):
    p=tmp_path/'audio.wav'; write_float(p,[float('nan'),0])
    with pytest.raises(ValueError): index_wav(p,scan=True)
    p.write_bytes(p.read_bytes()[:-1])
    with pytest.raises(ValueError): index_wav(p)

def test_residual_gain_and_seven_roles(tmp_path):
    for role in TRACKS: write_float(tmp_path/(role+'.wav'),[1,-1,0,0])
    write_float(tmp_path/'guitar.wav',[2,-2,0,0])
    manifest=validate_mix(tmp_path)
    assert len(manifest['assets'])==8
    assert 'guitar' not in [a['role'] for a in manifest['assets']]
    assert manifest['common_gain']==pytest.approx(.95/7)
    data,count=wire_chunk(tmp_path,manifest,0,1)
    assert count==1 and len(data)==8*2*4

def test_bad_residual_or_length_cannot_publish(tmp_path):
    for role in TRACKS: write_float(tmp_path/(role+'.wav'),[1,1])
    write_float(tmp_path/'guitar.wav',[0,0])
    with pytest.raises(ValueError,match='reconstruct'): validate_mix(tmp_path)
    write_float(tmp_path/'rhythm.wav',[1,1,0,0])
    with pytest.raises(ValueError): validate_mix(tmp_path)


def test_waveform_peaks_match_a_plain_sample_by_sample_reference(tmp_path):
    import random
    from chordbuddy.separation_checks import waveform_peaks
    rng=random.Random(5);frames=44100*2+1234
    samples=[rng.uniform(-1,1)*rng.random() for _ in range(frames*2)]
    p=tmp_path/'a.wav';write_float(p,samples);info=index_wav(p)
    got=waveform_peaks(info,lambda start,count:read_frames(p,info,start,count),bins=50)
    stored=list(array.array('f',samples));count=50;expected=[0.]*count
    for i in range(frames):
        bucket=i*count//frames;expected[bucket]=max(expected[bucket],abs(stored[i*2]),abs(stored[i*2+1]))
    assert got['peaks']==expected and got['frames']==frames
    write_float(p,[float('inf'),0]);bad=index_wav(p)
    with pytest.raises(ValueError):waveform_peaks(bad,lambda start,count:read_frames(p,bad,start,count))

def test_mix_validation_peak_and_gain_match_a_plain_reference(tmp_path):
    import random
    from chordbuddy.separation_checks import validate_mix
    rng=random.Random(9);frames=44100+777
    data={r:[rng.uniform(-.2,.2) for _ in range(frames*2)] for r in TRACKS if r not in ('lead','rhythm','guitar')}
    guitar=[rng.uniform(-.2,.2) for _ in range(frames*2)];lead=[rng.uniform(-.1,.1) for _ in range(frames*2)];data['lead']=lead;data['guitar']=guitar
    data['rhythm']=[g-l for g,l in zip(guitar,lead)]
    for role,values in data.items():write_float(tmp_path/(role+'.wav'),values)
    manifest=validate_mix(tmp_path)
    stored={role:list(array.array('f',values)) for role,values in data.items()}
    for role in ('rhythm',):stored[role]=list(array.array('f',data[role]))
    peak=0.
    for i in range(frames*2):peak=max(peak,abs(stored['original'][i]),sum(abs(stored[r][i]) for r in TRACKS[1:]))
    assert manifest['common_gain']==min(1.,.95/peak)
    data['rhythm'][5]+=.01;write_float(tmp_path/'rhythm.wav',data['rhythm'])
    with pytest.raises(ValueError,match='reconstruct'):validate_mix(tmp_path)

def test_fast_checks_agree_with_the_original_plain_python_versions(tmp_path):
    import random
    from chordbuddy import separation_audio as plain, separation_checks as fast
    rng=random.Random(2);frames=44100+500;data={}
    for r in TRACKS:
        if r not in ('lead','rhythm','guitar'):data[r]=[rng.uniform(-.3,.3) for _ in range(frames*2)]
    guitar=[rng.uniform(-.2,.2) for _ in range(frames*2)];lead=[rng.uniform(-.1,.1) for _ in range(frames*2)]
    data.update(guitar=guitar,lead=lead,rhythm=[g-l for g,l in zip(guitar,lead)])
    for role,values in data.items():write_float(tmp_path/(role+'.wav'),values)
    assert plain.validate_mix(tmp_path)==fast.validate_mix(tmp_path)
    info=index_wav(tmp_path/'original.wav');read=lambda start,count:read_frames(tmp_path/'original.wav',info,start,count)
    assert plain.waveform_peaks(info,read)==fast.waveform_peaks(info,read)
