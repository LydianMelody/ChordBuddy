"""Keep the chord model (SheetSage2 and its MERT-v2 encoder) working on transformers 5.

The model's own code was written for transformers 4.45. Version 5 fixed a string of security problems in 4.x but changed several things that
code relies on. The model files are pinned to exact commits (and the MERT files are checked against known hashes), so they are never edited.
Instead `apply()` adjusts transformers itself, in this one process, before the model is loaded. It does nothing on transformers 4.

What changed in version 5, and what is done about it:
- `BartDecoder(config, embed_tokens=...)` no longer takes `embed_tokens`: the argument is accepted and set afterwards.
- `_tied_weights_keys` must be a mapping, not a list: SheetSage2's is rewritten (its decoder and output layer share the token embedding).
- `tie_weights()` is now called with extra arguments (`recompute_mapping`, `missing_keys`) that older overrides do not accept: overrides are
  wrapped so they still run and the arguments still reach transformers.
- A config no longer has a `_commit_hash` attribute until a download sets it: it defaults to None.
- Buffers that are not saved with the weights are left as uninitialized memory when a model loads. MERT's rotary table (`inv_freq`) is one,
  and with garbage in it the encoder returns random numbers or NaN, and the chords come out wrong: it is recomputed after every load.
"""
import inspect

TIED_EMBEDDING = {'decoder.embed_tokens.weight': 'token_embedding.weight', 'output_projection.weight': 'token_embedding.weight'}
_applied = False


def major_version(version):
    try:
        return int(str(version).split('.')[0])
    except ValueError:
        return 0


def load_dtype_kwargs(dtype):
    """The keyword that picks a model's data type: `torch_dtype` before transformers 5, `dtype` from 5 on."""
    import transformers
    return {'dtype': dtype} if major_version(transformers.__version__) >= 5 else {'torch_dtype': dtype}


def rotary_frequencies(head_dim, base):
    import torch
    return 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float32) / head_dim))


def restore_rotary_tables(model):
    """Recompute the rotary frequency table of every MERT rotary embedding in a freshly loaded model."""
    for module in model.modules():
        table = getattr(module, 'inv_freq', None)
        if type(module).__name__ == 'RotaryEmbedding' and table is not None and hasattr(module, 'head_dim') and hasattr(module, 'base'):
            module.inv_freq = rotary_frequencies(module.head_dim, module.base).to(device=table.device)
    return model


def _accepts_extra_arguments(function):
    return any(p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL) for p in inspect.signature(function).parameters.values())


def adjust_model_class(cls):
    """Applied to every model class declared after `apply()`: remote model code is only imported when a model is loaded."""
    own = cls.__dict__.get('tie_weights')
    if own is not None and not _accepts_extra_arguments(own):
        def tie_weights(self, *args, **kwargs):
            own(self)
            # transformers 5 passes `missing_keys` here and expects tied weights to be struck off it
            return super(cls, self).tie_weights(*args, **kwargs)
        cls.tie_weights = tie_weights
    if cls.__name__ == 'SheetSage2Model' and isinstance(cls.__dict__.get('_tied_weights_keys'), list):
        cls._tied_weights_keys = dict(TIED_EMBEDDING)


def apply():
    """Make transformers 5 behave the way the chord model's code expects. Safe to call more than once; a no-op before version 5."""
    global _applied
    import transformers
    if _applied or major_version(transformers.__version__) < 5:
        return False
    from transformers import PretrainedConfig, PreTrainedModel
    from transformers.models.bart import modeling_bart
    if not hasattr(PretrainedConfig, '_commit_hash'):
        PretrainedConfig._commit_hash = None

    bart_init = modeling_bart.BartDecoder.__init__

    def decoder_init(self, config, embed_tokens=None, *args, **kwargs):
        bart_init(self, config, *args, **kwargs)
        if embed_tokens is not None:
            self.embed_tokens = embed_tokens
    modeling_bart.BartDecoder.__init__ = decoder_init

    subclass_hook = PreTrainedModel.__dict__['__init_subclass__'].__func__

    def init_subclass(cls, **kwargs):
        subclass_hook(cls, **kwargs)
        adjust_model_class(cls)
    PreTrainedModel.__init_subclass__ = classmethod(init_subclass)

    from_pretrained = PreTrainedModel.__dict__['from_pretrained'].__func__

    def load(cls, *args, **kwargs):
        loaded = from_pretrained(cls, *args, **kwargs)
        if isinstance(loaded, tuple):
            restore_rotary_tables(loaded[0])
        else:
            restore_rotary_tables(loaded)
        return loaded
    PreTrainedModel.from_pretrained = classmethod(load)
    _applied = True
    return True
