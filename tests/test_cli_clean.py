from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from deluge_tools.cli_clean import main


@pytest.fixture
def card_root(tmp_path: Path) -> Path:
    (tmp_path / "SONGS").mkdir()
    (tmp_path / "KITS").mkdir()
    (tmp_path / "SYNTHS").mkdir()
    (tmp_path / "SAMPLES" / "RECORD").mkdir(parents=True)
    return tmp_path


def _write_xml(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content).strip())


def _setup_card_with_unused(card_root: Path) -> None:
    (card_root / "SAMPLES" / "RECORD" / "USED.WAV").write_bytes(b"\x00" * 100)
    (card_root / "SAMPLES" / "RECORD" / "UNUSED.WAV").write_bytes(b"\x00" * 200)
    _write_xml(
        card_root / "SONGS" / "S.XML",
        """
        <song><osc fileName="SAMPLES/RECORD/USED.WAV" /></song>
    """,
    )


class TestCliClean:
    def test_version(self, capsys):
        with pytest.raises(SystemExit, match="0"):
            main(["--version"])
        assert "0.1.0" in capsys.readouterr().out

    def test_summary_default(self, card_root: Path, capsys):
        _setup_card_with_unused(card_root)
        main([str(card_root)])
        out = capsys.readouterr().out
        assert "Deluge SD Card:" in out
        assert "Samples" in out
        assert "Referenced" in out
        assert "1 files" in out
        assert "reclaimable" in out
        assert "UNUSED.WAV" not in out

    def test_summary_clean_card(self, card_root: Path, capsys):
        (card_root / "SAMPLES" / "RECORD" / "A.WAV").touch()
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/A.WAV" /></song>
        """,
        )
        main([str(card_root)])
        out = capsys.readouterr().out
        assert "Unused            0 files" in out

    def test_list_shows_filenames(self, card_root: Path, capsys):
        _setup_card_with_unused(card_root)
        main([str(card_root), "--list"])
        out = capsys.readouterr().out
        assert "SAMPLES/RECORD/UNUSED.WAV" in out

    def test_list_samples_only(self, card_root: Path, capsys):
        _setup_card_with_unused(card_root)
        _write_xml(
            card_root / "KITS" / "ORPHAN.XML",
            """
            <kit><osc fileName="SAMPLES/y.wav" /></kit>
        """,
        )
        main([str(card_root), "--list", "samples"])
        out = capsys.readouterr().out
        assert "UNUSED.WAV" in out
        assert "ORPHAN.XML" not in out

    def test_json_output(self, card_root: Path, capsys):
        _setup_card_with_unused(card_root)
        main([str(card_root), "--json"])
        data = json.loads(capsys.readouterr().out)
        assert "SAMPLES/RECORD/UNUSED.WAV" in data["unused_samples"]
        assert data["reclaimable_bytes"] == 200
        assert data["total_samples_bytes"] == 300

    def test_invalid_card(self, tmp_path: Path):
        with pytest.raises(SystemExit):
            main([str(tmp_path)])

    def test_no_args_non_tty(self, monkeypatch):
        monkeypatch.setattr("sys.stdin", open("/dev/null"))
        with pytest.raises(SystemExit):
            main([])

    def test_move_flag(self, card_root: Path, monkeypatch, capsys):
        _setup_card_with_unused(card_root)
        monkeypatch.setattr("builtins.input", lambda _: "y")
        monkeypatch.setattr("sys.stdin", type("FakeTTY", (), {"isatty": lambda self: True})())
        main([str(card_root), "--move"])
        out = capsys.readouterr().out
        assert "Moved 1 files" in out
        assert (card_root / "SAMPLES" / "_UNUSED" / "RECORD" / "UNUSED.WAV").exists()
        assert not (card_root / "SAMPLES" / "RECORD" / "UNUSED.WAV").exists()
        assert (card_root / "SAMPLES" / "RECORD" / "USED.WAV").exists()

    def test_move_abort(self, card_root: Path, monkeypatch, capsys):
        _setup_card_with_unused(card_root)
        monkeypatch.setattr("builtins.input", lambda _: "n")
        monkeypatch.setattr("sys.stdin", type("FakeTTY", (), {"isatty": lambda self: True})())
        main([str(card_root), "--move"])
        out = capsys.readouterr().out
        assert "Aborted" in out
        assert (card_root / "SAMPLES" / "RECORD" / "UNUSED.WAV").exists()
