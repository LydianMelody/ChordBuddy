import pytest
from unittest.mock import Mock
from chordbuddy import worker

def test_transcription_respects_shared_gpu_budget():
    assert hasattr(worker,'limit_gpu_memory'),'Transcription needs the same conservative GPU budget'
    cuda=Mock();cuda.mem_get_info.return_value=(6*1024**3,16*1024**3)
    worker.limit_gpu_memory(cuda)
    cuda.set_per_process_memory_fraction.assert_called_once_with(.25)
    cuda.mem_get_info.return_value=(4*1024**3,16*1024**3)
    with pytest.raises(RuntimeError,match='memory'):worker.limit_gpu_memory(cuda)
