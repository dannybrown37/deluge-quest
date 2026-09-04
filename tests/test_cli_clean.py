from __future__ import annotations

import json
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest

from deluge_tools.card_scanner import CardReport
from deluge_tools.cli_clean import _format_bytes, _move_unused, _prompt_for_card, main


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

    def test_move_non_tty_skips_confirm(self, card_root: Path, monkeypatch, capsys):
        _setup_card_with_unused(card_root)
        monkeypatch.setattr("sys.stdin", type("FakeNonTTY", (), {"isatty": lambda self: False})())
        main([str(card_root), "--move"])
        out = capsys.readouterr().out
        assert "Moved 1 files" in out
        assert (card_root / "SAMPLES" / "_UNUSED" / "RECORD" / "UNUSED.WAV").exists()

    def test_move_with_json_skips_confirm(self, card_root: Path, monkeypatch, capsys):
        _setup_card_with_unused(card_root)
        monkeypatch.setattr("sys.stdin", type("FakeTTY", (), {"isatty": lambda self: True})())
        main([str(card_root), "--move", "--json"])
        out = capsys.readouterr().out
        assert "Moved 1 files" in out

    def test_summary_shows_broken_refs(self, card_root: Path, capsys):
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/GONE.WAV" /></song>
        """,
        )
        main([str(card_root)])
        out = capsys.readouterr().out
        assert "Broken refs" in out

    def test_summary_shows_orphan_presets(self, card_root: Path, capsys):
        _write_xml(
            card_root / "KITS" / "ORPHAN.XML",
            """
            <kit><osc fileName="SAMPLES/y.wav" /></kit>
        """,
        )
        main([str(card_root)])
        out = capsys.readouterr().out
        assert "Orphan presets" in out

    def test_list_missing_only(self, card_root: Path, capsys):
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/GONE.WAV" /></song>
        """,
        )
        main([str(card_root), "--list", "missing"])
        out = capsys.readouterr().out
        assert "Broken references" in out
        assert "GONE.WAV" in out

    def test_list_presets_only(self, card_root: Path, capsys):
        _write_xml(
            card_root / "KITS" / "ORPHAN.XML",
            """
            <kit><osc fileName="SAMPLES/y.wav" /></kit>
        """,
        )
        main([str(card_root), "--list", "presets"])
        out = capsys.readouterr().out
        assert "Orphan presets" in out
        assert "ORPHAN.XML" in out

    def test_list_clean_card(self, card_root: Path, capsys):
        (card_root / "SAMPLES" / "RECORD" / "A.WAV").touch()
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/A.WAV" /></song>
        """,
        )
        main([str(card_root), "--list"])
        out = capsys.readouterr().out
        assert "Nothing to list" in out


class TestMoveUnused:
    def test_skips_sample_missing_on_disk(self, card_root: Path):
        report = CardReport(unused_samples={"SAMPLES/RECORD/GHOST.WAV"})
        moved = _move_unused(card_root, report)
        assert moved == 0

    def test_moves_existing_sample(self, card_root: Path):
        (card_root / "SAMPLES" / "RECORD" / "A.WAV").write_bytes(b"\x00")
        report = CardReport(unused_samples={"SAMPLES/RECORD/A.WAV"})
        moved = _move_unused(card_root, report)
        assert moved == 1
        assert (card_root / "SAMPLES" / "_UNUSED" / "RECORD" / "A.WAV").exists()


class TestFormatBytes:
    @pytest.mark.parametrize(
        ("n", "expected"),
        [
            (0, "0 B"),
            (1023, "1023 B"),
            (1024, "1.0 KB"),
            (1024 * 1024 - 1, "1024.0 KB"),
            (1024 * 1024, "1.0 MB"),
            (1024 * 1024 * 1024 - 1, "1024.0 MB"),
            (1024 * 1024 * 1024, "1.00 GB"),
        ],
    )
    def test_formats_each_magnitude(self, n: int, expected: str):
        assert _format_bytes(n) == expected


@pytest.fixture()
def _fake_tty():
    with patch("sys.stdin") as mock_stdin:
        mock_stdin.isatty.return_value = True
        yield


@pytest.mark.usefixtures("_fake_tty")
class TestPromptForCard:
    def test_uses_folder_picker(self, tmp_path: Path):
        with patch("deluge_tools.cli_clean._browse_for_folder", return_value=tmp_path):
            result = _prompt_for_card()
        assert result == tmp_path

    def test_falls_back_to_input_on_cancel(self, tmp_path: Path):
        with (
            patch("deluge_tools.cli_clean._browse_for_folder", return_value=None),
            patch("builtins.input", return_value=str(tmp_path)),
        ):
            result = _prompt_for_card()
        assert result == tmp_path

    def test_falls_back_to_input_when_selection_missing(self, tmp_path: Path):
        ghost = tmp_path / "does-not-exist"
        with (
            patch("deluge_tools.cli_clean._browse_for_folder", return_value=ghost),
            patch("builtins.input", return_value=str(tmp_path)),
        ):
            result = _prompt_for_card()
        assert result == tmp_path

    def test_input_path_missing_exits(self, tmp_path: Path, capsys):
        ghost = tmp_path / "does-not-exist"
        with (
            patch("deluge_tools.cli_clean._browse_for_folder", return_value=None),
            patch("builtins.input", return_value=str(ghost)),
            pytest.raises(SystemExit) as exc,
        ):
            _prompt_for_card()
        assert exc.value.code == 1
        assert "does not exist" in capsys.readouterr().err

    def test_not_a_tty_raises(self):
        with patch("sys.stdin") as mock_stdin:
            mock_stdin.isatty.return_value = False
            with pytest.raises(SystemExit):
                _prompt_for_card()
