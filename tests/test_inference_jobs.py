import pytest
from chordbuddy.inference_jobs import InferenceGate
def test_gate_rejects_second_owner_and_stale_release():
    gate=InferenceGate();owner=gate.try_acquire('separation','a','1')
    with pytest.raises(RuntimeError):gate.try_acquire('transcription','b','2')
    gate.release('wrong')
    with pytest.raises(RuntimeError):gate.try_acquire('separation','c','3')
    gate.release(owner);assert gate.try_acquire('transcription','b','2')

