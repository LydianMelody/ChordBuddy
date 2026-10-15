"""Use Hugging Face's built-in file-copy cache mode for our local hub.

The pinned huggingface_hub 0.36.0 symlink probe publishes an optimistic
result before its first Windows test finishes. Parallel downloads can then
attempt a privileged symlink. Selecting the existing copy/move branch for
our hub avoids that race and requires neither administrator nor Developer Mode.
This changes only the inference process, never installed package files.
"""
from pathlib import Path


def configure_hub_copy_fallback(cache_dir):
    from huggingface_hub import file_download

    root = Path(cache_dir).resolve()
    upstream = file_download.are_symlinks_supported

    def supported(path=None):
        candidate = Path(path if path is not None else file_download.constants.HF_HUB_CACHE).resolve()
        if candidate.is_relative_to(root):
            return False
        return upstream(path)

    file_download.are_symlinks_supported = supported
