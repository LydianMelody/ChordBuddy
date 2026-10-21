"""The chord model's code was written for transformers 4.45; chordbuddy/transformers_compat.py keeps it working on 5.x.

These tests build a small stand-in with the same structure as SheetSage2 (a shared token embedding, a BartDecoder, a MERT-style rotary
table) and check it behaves the same before and after saving and loading. They run on whichever transformers is installed: on 4.x the
compatibility layer does nothing and the stand-in must still work, on 5.x it must be applied.
"""
import pytest

torch = pytest.importorskip('torch')
transformers = pytest.importorskip('transformers')

from chordbuddy import transformers_compat as compat

V5 = compat.major_version(transformers.__version__) >= 5


def test_version_parsing_and_dtype_keyword():
    assert compat.major_version('5.20.2') == 5 and compat.major_version('4.45.2') == 4 and compat.major_version('x') == 0
    assert set(compat.load_dtype_kwargs(torch.float32)) == ({'dtype'} if V5 else {'torch_dtype'})


def test_apply_changes_nothing_before_version_5_and_can_repeat():
    compat.apply()
    assert compat.apply() is False                     # a second call does nothing (and on 4.x so does the first)


def test_rotary_table_formula_matches_mert():
    table = compat.rotary_frequencies(64, 10000.0)
    assert table.shape == (32,) and table[0] == 1.0
    assert torch.allclose(table[1], torch.tensor(10000.0 ** (-2 / 64)))


def test_restore_rotary_tables_replaces_garbage():
    class RotaryEmbedding(torch.nn.Module):        # same name and fields as MERT's
        def __init__(self):
            super().__init__()
            self.head_dim, self.base = 16, 10000.0
            self.register_buffer('inv_freq', torch.full((8,), -2112132.25), persistent=False)

    holder = torch.nn.Sequential(RotaryEmbedding())
    compat.restore_rotary_tables(holder)
    assert torch.equal(holder[0].inv_freq, compat.rotary_frequencies(16, 10000.0))
    other = torch.nn.Sequential(torch.nn.Linear(2, 2))
    assert compat.restore_rotary_tables(other) is other


def build_standins():
    """Defined after apply(), the way the model's own code is when a model is loaded."""
    compat.apply()
    from transformers import BartConfig, PretrainedConfig, PreTrainedModel
    from transformers.models.bart.modeling_bart import BartDecoder

    class RotaryEmbedding(torch.nn.Module):
        def __init__(self, config):
            super().__init__()
            self.head_dim, self.base = config.hidden_size // 2, 10000.0
            self.register_buffer('inv_freq', compat.rotary_frequencies(self.head_dim, self.base), persistent=False)

    class StandInConfig(PretrainedConfig):
        model_type = 'chordbuddy-standin'

        def __init__(self, vocab_size=32, hidden_size=16, **kwargs):
            self.vocab_size, self.hidden_size = vocab_size, hidden_size
            kwargs.setdefault('tie_word_embeddings', True)      # as SheetSage2's own config does
            super().__init__(**kwargs)

    class StandInEncoder(PreTrainedModel):
        config_class = StandInConfig

        def __init__(self, config):
            super().__init__(config)
            self.embed_positions = RotaryEmbedding(config)
            self.proj = torch.nn.Linear(config.hidden_size, config.hidden_size)
            self.post_init()

        def _init_weights(self, module):
            if isinstance(module, torch.nn.Linear):
                torch.nn.init.normal_(module.weight, std=0.02)

    class SheetSage2Model(PreTrainedModel):         # the name matters: it is how the compatibility layer finds the model
        config_class = StandInConfig
        _tied_weights_keys = ['decoder.embed_tokens.weight', 'output_projection.weight']

        def __init__(self, config):
            super().__init__(config)
            self.encoder = StandInEncoder(config)
            bart = BartConfig(vocab_size=config.vocab_size, d_model=config.hidden_size, decoder_layers=1, decoder_attention_heads=2,
                              decoder_ffn_dim=32, max_position_embeddings=64, pad_token_id=0, is_encoder_decoder=True)
            bart._attn_implementation = 'eager'
            self.token_embedding = torch.nn.Embedding(config.vocab_size, config.hidden_size, padding_idx=0)
            self.decoder = BartDecoder(bart, embed_tokens=self.token_embedding)
            self.output_projection = torch.nn.Linear(config.hidden_size, config.vocab_size, bias=False)
            self.output_projection.weight = self.token_embedding.weight
            self.post_init()

        def get_input_embeddings(self):
            return self.token_embedding

        def get_output_embeddings(self):
            return self.output_projection

        def tie_weights(self):                       # no extra arguments, as in the model's code
            super().tie_weights()
            if hasattr(self, 'decoder') and hasattr(self, 'token_embedding'):
                self.decoder.embed_tokens.weight = self.token_embedding.weight

        def _init_weights(self, module):
            if isinstance(module, (torch.nn.Linear, torch.nn.Embedding)):
                torch.nn.init.normal_(module.weight, std=0.02)

        def decode(self, memory, ids):
            return self.output_projection(self.decoder(input_ids=ids, encoder_hidden_states=memory, use_cache=False).last_hidden_state)

    return SheetSage2Model, StandInConfig


@pytest.fixture(scope='module')
def standins():
    return build_standins()


def test_standin_loads_with_shared_weights_and_a_correct_rotary_table(standins, tmp_path):
    model_class, config_class = standins
    original = model_class(config_class()).eval()
    original.save_pretrained(tmp_path)

    loaded, info = model_class.from_pretrained(tmp_path, output_loading_info=True)
    loaded.eval()
    # the model's own loader refuses weights with anything missing; shared weights must not be reported as missing
    assert not info['missing_keys'] and not info['unexpected_keys']
    assert loaded.decoder.embed_tokens.weight.data_ptr() == loaded.token_embedding.weight.data_ptr()
    assert loaded.output_projection.weight.data_ptr() == loaded.token_embedding.weight.data_ptr()
    assert torch.equal(loaded.token_embedding.weight, original.token_embedding.weight)
    # a non-saved buffer must not come back as uninitialized memory (this is what made the real encoder return NaN)
    assert torch.equal(loaded.encoder.embed_positions.inv_freq, compat.rotary_frequencies(8, 10000.0))
    memory, ids = torch.randn(1, 5, 16), torch.tensor([[1, 2, 3, 4]])
    with torch.no_grad():
        assert torch.allclose(loaded.decode(memory, ids), original.decode(memory, ids), atol=1e-6)


def test_tied_weight_declaration_is_converted_only_for_sheetsage2(standins):
    model_class, _ = standins
    if V5:
        assert model_class._tied_weights_keys == compat.TIED_EMBEDDING
    else:
        assert isinstance(model_class._tied_weights_keys, list)


@pytest.mark.skipif(not V5, reason='what version 5 changed')
def test_config_has_a_commit_hash_attribute_on_version_5(standins):
    _, config_class = standins
    assert config_class()._commit_hash is None
