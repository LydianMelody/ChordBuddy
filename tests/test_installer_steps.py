"""The Windows installer keeps going when one part fails, and falls back to the CPU engine when the graphics card version cannot be used."""
import install_windows_dependencies as inst


def fake_steps(monkeypatch, fail=()):
    ran = []

    def make(name):
        def step(ctx):
            ran.append(name)
            if name in fail:
                raise inst.Failure(name + ' broke.')
        return step
    for name in inst.STEPS:
        monkeypatch.setattr(inst, 'step_' + name, make(name))
    monkeypatch.setattr(inst, 'save_state', lambda state: None)
    return ran


def test_a_failed_step_does_not_stop_the_others(monkeypatch):
    ran = fake_steps(monkeypatch, fail={'ffmpeg'})
    failed, skipped = inst.run_steps(inst.STEPS, {'device': 'cpu', 'state': {}, 'notes': []})
    assert failed == {'ffmpeg': 'ffmpeg broke.'}
    assert skipped == {'check': 'ffmpeg'}                  # the check needs ffmpeg; everything else still ran
    assert ran == [s for s in inst.STEPS if s != 'check']


def test_steps_that_need_a_failed_one_are_skipped(monkeypatch):
    ran = fake_steps(monkeypatch, fail={'engine'})
    failed, skipped = inst.run_steps(inst.STEPS, {'device': 'cpu', 'state': {}, 'notes': []})
    assert list(failed) == ['engine']
    assert skipped == {'separation': 'engine', 'sheetsage': 'engine', 'check': 'engine'}
    assert 'app' in ran and 'ffmpeg' in ran and 'models' in ran


def test_an_unexpected_error_is_reported_not_raised(monkeypatch):
    fake_steps(monkeypatch)
    monkeypatch.setattr(inst, 'step_models', lambda ctx: (_ for _ in ()).throw(OSError('disk full')))
    failed, _ = inst.run_steps(['models'], {'device': 'cpu', 'state': {}, 'notes': []})
    assert failed == {'models': 'OSError: disk full'}


def engine_ctx(monkeypatch, cuda_installs, gpu_ok):
    installed = []

    def install(ctx, device):
        if device == 'cuda' and not cuda_installs:
            raise inst.Failure('pip could not install the libraries.')
        installed.append(device)
    monkeypatch.setattr(inst, 'install_engine', install)
    monkeypatch.setattr(inst, 'gpu_works', lambda: gpu_ok)
    return {'device': 'cuda', 'state': {}, 'notes': []}, installed


def test_cuda_install_failure_falls_back_to_cpu(monkeypatch):
    ctx, installed = engine_ctx(monkeypatch, cuda_installs=False, gpu_ok=False)
    inst.step_engine(ctx)
    assert installed == ['cpu'] and ctx['device'] == 'cpu' and ctx['state']['device_fallback'] == 'cpu' and ctx['notes']


def test_too_old_graphics_card_falls_back_to_cpu(monkeypatch):
    ctx, installed = engine_ctx(monkeypatch, cuda_installs=True, gpu_ok=False)
    inst.step_engine(ctx)
    assert installed == ['cuda', 'cpu'] and ctx['device'] == 'cpu'


def test_working_graphics_card_keeps_cuda(monkeypatch):
    ctx, installed = engine_ctx(monkeypatch, cuda_installs=True, gpu_ok=True)
    ctx['state']['device_fallback'] = 'cpu'
    inst.step_engine(ctx)
    assert installed == ['cuda'] and ctx['device'] == 'cuda' and 'device_fallback' not in ctx['state'] and not ctx['notes']


def test_auto_remembers_the_cpu_fallback(monkeypatch, capsys):
    monkeypatch.setattr(inst, 'load_state', lambda: {'device_fallback': 'cpu'})
    monkeypatch.setattr(inst, 'has_nvidia', lambda: True)
    monkeypatch.setattr(inst, 'check_webview2', lambda: True)
    seen = {}
    monkeypatch.setattr(inst, 'run_steps', lambda names, ctx: (seen.update(ctx), ({}, {}))[1])
    monkeypatch.setattr(inst.sys, 'platform', 'win32')
    assert inst.main(['--only', 'engine']) == 0
    assert seen['device'] == 'cpu'


def test_summary_lists_failures_and_exits_1(monkeypatch, capsys):
    monkeypatch.setattr(inst, 'load_state', lambda: {})
    monkeypatch.setattr(inst, 'check_webview2', lambda: True)
    monkeypatch.setattr(inst, 'run_steps', lambda names, ctx: ({'ffmpeg': 'Could not download ffmpeg 6.0.'}, {'check': 'ffmpeg'}))
    monkeypatch.setattr(inst.sys, 'platform', 'win32')
    assert inst.main(['--device', 'cpu']) == 1
    out = capsys.readouterr().out
    assert 'some parts did not install' in out and 'ffmpeg (reading audio files): Could not download' in out and 'check (final engine check): skipped' in out
