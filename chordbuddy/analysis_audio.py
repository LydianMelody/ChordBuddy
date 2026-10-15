"""Prepare one explicitly timed canonical recording without changing source bytes."""
import shutil
from pathlib import Path
from .separation_audio import index_wav
from .separation_contract import file_hash
from .owned_process import OwnedProcess
from .path_policy import worker_environment as environment
from .path_policy import validate_paths,worker_paths

def prepare_source(project,source,output,check_cancel,*,reserved=False):
    check_cancel()
    project=Path(project).resolve();source=Path(source).resolve();output=Path(output).resolve()
    if not source.is_relative_to(project) or not output.is_relative_to(project):raise ValueError('Audio must remain inside the project')
    validate_paths(worker_paths(output))
    if reserved:
        if not output.is_dir() or any(output.iterdir()):raise ValueError("Reserved analysis folder must be empty")
    else:output.mkdir(parents=True,exist_ok=False)
    source_hash=file_hash(source);snapshot=output/'source.mp3';shutil.copyfile(source,snapshot)
    if file_hash(snapshot)!=source_hash:raise ValueError('Source changed while copying')
    check_cancel();wav=output/'original.wav';ffmpeg=project/'tools/ffmpeg.exe'
    argv=[str(ffmpeg),'-nostdin','-v','error','-n','-i',str(snapshot),'-ar','44100','-ac','2','-c:a','pcm_f32le',str(wav)]
    with OwnedProcess(argv,cwd=project,env=environment(project,output)) as proc:
        # FFmpeg is a short decode; cancellation waits for owned child exit.
        for line in proc.stdout:check_cancel()
        code=proc.wait()
    check_cancel()
    if code:raise ValueError('Canonical audio preparation failed')
    if file_hash(source)!=source_hash:raise ValueError('Source changed during preparation')
    info=index_wav(wav,scan=True)
    return dict(info,source_sha256=source_hash,time_origin=0,decoder_sha256=file_hash(ffmpeg),
                decode_options=argv[1:10],path=str(wav),sha256=file_hash(wav))
