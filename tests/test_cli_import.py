from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from deluge_tools.cli_import import main


@pytest.fixture()
def midi_file(tmp_path: Path) -> Path:
    f = tmp_path / "song.mid"
    f.write_bytes(b"")
    return f


class TestCliImport:
    def test_version(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["--version"])
        assert exc.value.code == 0
        assert capsys.readouterr().out

    def test_no_input_prints_help_and_exits(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main([])
        assert exc.value.code == 1
        assert "usage" in capsys.readouterr().out.lower()

    def test_missing_file_exits_with_error(self, tmp_path: Path, capsys):
        missing = tmp_path / "missing.mid"
        with pytest.raises(SystemExit) as exc:
            main([str(missing)])
        assert exc.value.code == 1
        assert "not found" in capsys.readouterr().err

    def test_default_output_and_scale(self, midi_file: Path, capsys):
        with patch("deluge_tools.cli_import.midi_to_deluge_xml") as mock_convert:
            main([str(midi_file)])
        expected_output = midi_file.with_suffix(".XML")
        mock_convert.assert_called_once_with(
            midi_file,
            expected_output,
            root_note=0,
            mode_notes=[0, 2, 4, 5, 7, 9, 11],
        )
        assert f"Written: {expected_output}" in capsys.readouterr().out

    def test_explicit_output_path(self, midi_file: Path, tmp_path: Path):
        out = tmp_path / "custom.XML"
        with patch("deluge_tools.cli_import.midi_to_deluge_xml") as mock_convert:
            main([str(midi_file), "-o", str(out)])
        assert mock_convert.call_args.args == (midi_file, out)

    def test_root_note_passed_through(self, midi_file: Path):
        with patch("deluge_tools.cli_import.midi_to_deluge_xml") as mock_convert:
            main([str(midi_file), "--root-note", "5"])
        assert mock_convert.call_args.kwargs["root_note"] == 5

    def test_minor_scale_passed_through(self, midi_file: Path):
        with patch("deluge_tools.cli_import.midi_to_deluge_xml") as mock_convert:
            main([str(midi_file), "--scale", "minor"])
        assert mock_convert.call_args.kwargs["mode_notes"] == [0, 2, 3, 5, 7, 8, 10]
