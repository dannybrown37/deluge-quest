from __future__ import annotations

import os
from pathlib import Path

from deluge_tools.filesync import dir_size, sync_tree


class TestSyncTree:
    def test_copies_new_files(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("hello")
        (src / "sub").mkdir()
        (src / "sub" / "b.txt").write_text("world")

        sync_tree(src, dst)

        assert (dst / "a.txt").read_text() == "hello"
        assert (dst / "sub" / "b.txt").read_text() == "world"

    def test_updates_changed_files(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("new")
        (dst / "a.txt").write_text("old")
        os.utime(dst / "a.txt", (0, 0))

        sync_tree(src, dst)

        assert (dst / "a.txt").read_text() == "new"

    def test_skips_unchanged_files(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("same")
        (dst / "a.txt").write_text("same")
        src_stat = (src / "a.txt").stat()
        os.utime(dst / "a.txt", (src_stat.st_atime, src_stat.st_mtime))

        original_mtime = (dst / "a.txt").stat().st_mtime
        sync_tree(src, dst)
        assert (dst / "a.txt").stat().st_mtime == original_mtime

    def test_deletes_extra_files_with_mirror(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (dst / "stale.txt").write_text("gone")

        sync_tree(src, dst, delete=True)

        assert not (dst / "stale.txt").exists()

    def test_keeps_extra_files_without_mirror(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (dst / "stale.txt").write_text("kept")

        sync_tree(src, dst, delete=False)

        assert (dst / "stale.txt").exists()

    def test_excludes_patterns(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "keep.txt").write_text("yes")
        (src / ".git").mkdir()
        (src / ".git" / "config").write_text("no")
        (src / "README.md").write_text("no")

        sync_tree(src, dst, excludes=[".git", "README.md"])

        assert (dst / "keep.txt").exists()
        assert not (dst / ".git").exists()
        assert not (dst / "README.md").exists()

    def test_excludes_not_deleted_with_mirror(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (dst / ".git").mkdir()
        (dst / ".git" / "config").write_text("precious")

        sync_tree(src, dst, delete=True, excludes=[".git"])

        assert (dst / ".git" / "config").read_text() == "precious"

    def test_include_filter(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "song.XML").write_text("<song/>")
        (src / "data.json").write_text("{}")
        (src / "sample.wav").write_text("audio")
        (src / "sub").mkdir()
        (src / "sub" / "patch.XML").write_text("<patch/>")

        sync_tree(src, dst, includes=["*.XML", "*.xml", "*.JSON", "*.json"])

        assert (dst / "song.XML").exists()
        assert (dst / "data.json").exists()
        assert (dst / "sub" / "patch.XML").exists()
        assert not (dst / "sample.wav").exists()

    def test_dry_run_returns_changes(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "new.txt").write_text("new")
        (dst / "stale.txt").write_text("old")

        changes = sync_tree(src, dst, delete=True, dry_run=True)

        assert (dst / "stale.txt").exists()
        assert not (dst / "new.txt").exists()
        assert any("new.txt" in c for c in changes)
        assert any("stale.txt" in c for c in changes)

    def test_verbose_returns_changes(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("hello")

        changes = sync_tree(src, dst, verbose=True)

        assert any("a.txt" in c for c in changes)

    def test_creates_dst_if_missing(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        (src / "a.txt").write_text("hello")

        sync_tree(src, dst)

        assert (dst / "a.txt").read_text() == "hello"

    def test_preserves_mtime(self, tmp_path: Path):
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("hello")
        os.utime(src / "a.txt", (1000000, 1000000))

        sync_tree(src, dst)

        assert abs((dst / "a.txt").stat().st_mtime - 1000000) < 2


class TestDirSize:
    def test_counts_file_sizes(self, tmp_path: Path):
        (tmp_path / "a.txt").write_bytes(b"x" * 1000)
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "b.txt").write_bytes(b"y" * 2000)

        size = dir_size(tmp_path)

        assert size >= 3000

    def test_excludes_dirs(self, tmp_path: Path):
        (tmp_path / "a.txt").write_bytes(b"x" * 1000)
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "objects").write_bytes(b"y" * 9000)

        total = dir_size(tmp_path)
        without_git = dir_size(tmp_path, excludes=[".git"])

        assert without_git < total
        assert without_git >= 1000

    def test_empty_dir(self, tmp_path: Path):
        assert dir_size(tmp_path) == 0
