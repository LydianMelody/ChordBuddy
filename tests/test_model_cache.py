from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try:
    from huggingface_hub import file_download
except ImportError:
    file_download = None
try:
    from chordbuddy.model_cache import configure_hub_copy_fallback
except ImportError:
    configure_hub_copy_fallback = None


@unittest.skipIf(file_download is None, 'Run model cache tests in the inference environment')
class ModelCacheTests(unittest.TestCase):
    def test_denied_windows_symlink_copies_existing_blob_without_admin(self):
        self.assertIsNotNone(configure_hub_copy_fallback, 'Model cache fallback is not implemented')
        with tempfile.TemporaryDirectory() as tmp:
            hub = Path(tmp) / 'hub'
            blob = hub / 'models--fixture' / 'blobs' / 'hash'
            snapshot = hub / 'models--fixture' / 'snapshots' / 'revision' / 'model.bin'
            blob.parent.mkdir(parents=True)
            snapshot.parent.mkdir(parents=True)
            blob.write_bytes(b'real cached blob fixture')
            with patch.object(file_download, 'are_symlinks_supported', return_value=True), \
                    patch.object(file_download.os, 'symlink', side_effect=OSError(1314, 'privilege denied')):
                configure_hub_copy_fallback(hub)
                file_download._create_symlink(str(blob), str(snapshot), new_blob=False)
            self.assertEqual(snapshot.read_bytes(), blob.read_bytes())
            self.assertFalse(snapshot.is_symlink())

    def test_new_blob_moves_and_unrelated_cache_keeps_upstream_behavior(self):
        self.assertIsNotNone(configure_hub_copy_fallback, 'Model cache fallback is not implemented')
        with tempfile.TemporaryDirectory() as tmp:
            hub = Path(tmp) / 'hub'
            blob = hub / 'blobs' / 'hash'
            target = hub / 'snapshot' / 'model.bin'
            blob.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            blob.write_bytes(b'new blob fixture')
            with patch.object(file_download, 'are_symlinks_supported', return_value=True):
                configure_hub_copy_fallback(hub)
                self.assertTrue(file_download.are_symlinks_supported(Path(tmp) / 'elsewhere'))
                file_download._create_symlink(str(blob), str(target), new_blob=True)
            self.assertEqual(target.read_bytes(), b'new blob fixture')
            self.assertFalse(blob.exists())
