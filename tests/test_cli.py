from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deluge_tools.cli import _find_musescore, _open_in_musescore, main
from deluge_tools.converter import NoArrangementError


@dataclass
class FakeSong:
    bpm: float = 120.0
    instruments: list = field(default_factory=lambda: [1, 2])
    clips: list = field(default_factory=lambda: [1])
    in_arrangement_view: bool = True
    root_note: int = 0
    mode_notes: list = field(default_factory=lambda: [0, 2, 4, 5, 7, 9, 11])


class FakePart:
    def __init__(self, name: str, notes: list):
        self.partName = name
        self._notes = notes

    def flatten(self):
        return self

    @property
    def notes(self):
        return self._notes


class FakeScore:
    def __init__(self):
        self.parts = [FakePart("Synth", [1, 2, 3])]
        self.write_calls: list[tuple[str, str]] = []

    def write(self, fmt: str, fp: str):
        self.write_calls.append((fmt, fp))
        Path(fp).write_text(f"fake {fmt} content")

    def show(self, fmt: str, returnRecordingFilePath: bool = False):
        return "fake text content"


@pytest.fixture()
def song_file(tmp_path: Path) -> Path:
    f = tmp_path / "song.XML"
    f.write_text("<song/>")
    return f


@pytest.fixture(autouse=True)
def _patch_parse(request):
    if "no_parse_patch" in request.keywords:
        yield
        return
    with patch("deluge_tools.cli.parse_song", return_value=FakeSong()):
        yield


class TestFindMusescore:
    def test_finds_via_which(self):
        with patch(
            "shutil.which", side_effect=lambda name: "/usr/bin/mscore" if name == "mscore" else None
        ):
            assert _find_musescore() == "mscore"

    def test_finds_via_hardcoded_path(self):
        with (
            patch("shutil.which", return_value=None),
            patch.object(Path, "exists", return_value=True),
        ):
            result = _find_musescore()
        assert result == "/mnt/c/Program Files/MuseScore 4/bin/MuseScore4.exe"

    def test_returns_none_when_not_found(self):
        with (
            patch("shutil.which", return_value=None),
            patch.object(Path, "exists", return_value=False),
        ):
            assert _find_musescore() is None


class TestOpenInMusescore:
    def test_returns_false_when_not_found(self, tmp_path: Path):
        out = tmp_path / "out.musicxml"
        out.write_text("x")
        with patch("deluge_tools.cli._find_musescore", return_value=None):
            assert _open_in_musescore(out) is False

    def test_opens_native_binary(self, tmp_path: Path):
        out = tmp_path / "out.musicxml"
        out.write_text("x")
        with (
            patch("deluge_tools.cli._find_musescore", return_value="mscore"),
            patch("subprocess.Popen") as mock_popen,
        ):
            assert _open_in_musescore(out) is True
        assert mock_popen.call_args[0][0][0] == "mscore"

    def test_opens_windows_musescore_with_existing_temp(self, tmp_path: Path):
        out = tmp_path / "out.musicxml"
        out.write_text("x")
        with (
            patch(
                "deluge_tools.cli._find_musescore",
                return_value="/mnt/c/Program Files/MuseScore 4/bin/MuseScore4.exe",
            ),
            patch.object(Path, "exists", return_value=True),
            patch("shutil.copy2") as mock_copy,
            patch(
                "subprocess.run",
                return_value=MagicMock(
                    stdout="C:\\Users\\danny\\AppData\\Local\\Temp\\out.musicxml\n"
                ),
            ) as mock_run,
            patch("subprocess.Popen") as mock_popen,
        ):
            assert _open_in_musescore(out) is True
        mock_copy.assert_called_once()
        mock_run.assert_called_once()
        mock_popen.assert_called_once()

    def test_opens_windows_musescore_falls_back_to_c_temp(self, tmp_path: Path):
        out = tmp_path / "out.musicxml"
        out.write_text("x")
        with (
            patch(
                "deluge_tools.cli._find_musescore",
                return_value="/mnt/c/Program Files/MuseScore 4/bin/MuseScore4.exe",
            ),
            patch.object(Path, "exists", return_value=False),
            patch("shutil.copy2") as mock_copy,
            patch("subprocess.run", return_value=MagicMock(stdout="C:\\Temp\\out.musicxml\n")),
            patch("subprocess.Popen"),
        ):
            assert _open_in_musescore(out) is True
        copy_dest = mock_copy.call_args[0][1]
        assert str(copy_dest).startswith("/mnt/c/Temp")


class TestMainArgHandling:
    @pytest.mark.no_parse_patch
    def test_no_input_prints_help_and_exits(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main([])
        assert exc.value.code == 1
        assert "usage" in capsys.readouterr().out.lower()

    @pytest.mark.no_parse_patch
    def test_missing_file_exits_with_error(self, tmp_path: Path, capsys):
        missing = tmp_path / "missing.xml"
        with pytest.raises(SystemExit) as exc:
            main([str(missing)])
        assert exc.value.code == 1
        assert "not found" in capsys.readouterr().err

    @pytest.mark.no_parse_patch
    def test_version_flag(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["--version"])
        assert exc.value.code == 0
        assert "cli.py" not in capsys.readouterr().out


class TestMainFormatInference:
    @pytest.mark.parametrize(
        ("output_name", "expected_fmt"),
        [
            ("out.musicxml", "musicxml"),
            ("out.xml", "musicxml"),
            ("out.mid", "midi"),
            ("out.midi", "midi"),
            ("out.ly", "lilypond"),
            ("out.txt", "text"),
            ("out.unknown", "musicxml"),
        ],
    )
    def test_infers_format_from_suffix(
        self, song_file: Path, tmp_path: Path, output_name: str, expected_fmt: str
    ):
        out = tmp_path / output_name
        with (
            patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>") as mock_xml,
            patch("deluge_tools.cli.song_to_score", return_value=FakeScore()) as mock_score,
        ):
            main([str(song_file), "-o", str(out), "--no-open"])
        if expected_fmt == "musicxml":
            mock_xml.assert_called_once()
            mock_score.assert_not_called()
        else:
            mock_score.assert_called_once()
            mock_xml.assert_not_called()

    def test_explicit_format_overrides_suffix(self, song_file: Path, tmp_path: Path):
        out = tmp_path / "out.xml"
        with (
            patch("deluge_tools.cli.song_to_musicxml") as mock_xml,
            patch("deluge_tools.cli.song_to_score", return_value=FakeScore()) as mock_score,
        ):
            main([str(song_file), "-o", str(out), "-f", "midi", "--no-open"])
        mock_score.assert_called_once()
        mock_xml.assert_not_called()

    def test_default_output_path_when_omitted(self, song_file: Path):
        with patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>"):
            main([str(song_file), "--no-open"])
        expected = song_file.with_suffix(".musicxml")
        assert expected.exists()
        assert expected.read_text() == "<xml/>"


class TestMainMusicXmlPath:
    def test_writes_musicxml_and_prints_summary(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.musicxml"
        with patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>"):
            main([str(song_file), "-o", str(out), "--no-open"])
        assert out.read_text() == "<xml/>"
        captured = capsys.readouterr()
        assert "Parsed:" in captured.out
        assert f"Written: {out}" in captured.out

    def test_no_arrangement_error_exits(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.musicxml"
        with (
            patch("deluge_tools.cli.song_to_musicxml", side_effect=NoArrangementError("no clips")),
            pytest.raises(SystemExit) as exc,
        ):
            main([str(song_file), "-o", str(out), "--no-open"])
        assert exc.value.code == 1
        assert "no clips" in capsys.readouterr().err


class TestMainScorePath:
    def test_writes_midi_and_prints_parts(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.mid"
        score = FakeScore()
        with patch("deluge_tools.cli.song_to_score", return_value=score):
            main([str(song_file), "-o", str(out), "--no-open"])
        assert score.write_calls == [("midi", str(out))]
        captured = capsys.readouterr()
        assert "Part: Synth — 3 notes" in captured.out
        assert f"Written: {out}" in captured.out

    def test_writes_text_via_show(self, song_file: Path, tmp_path: Path):
        out = tmp_path / "out.txt"
        with patch("deluge_tools.cli.song_to_score", return_value=FakeScore()):
            main([str(song_file), "-o", str(out), "--no-open"])
        assert out.read_text() == "fake text content"

    def test_no_arrangement_error_exits(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.mid"
        with (
            patch("deluge_tools.cli.song_to_score", side_effect=NoArrangementError("no clips")),
            pytest.raises(SystemExit) as exc,
        ):
            main([str(song_file), "-o", str(out), "--no-open"])
        assert exc.value.code == 1
        assert "no clips" in capsys.readouterr().err


class TestMainMuseScoreOpening:
    def test_opens_musescore_on_success(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.musicxml"
        with (
            patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>"),
            patch("deluge_tools.cli._open_in_musescore", return_value=True) as mock_open,
        ):
            main([str(song_file), "-o", str(out)])
        mock_open.assert_called_once_with(out)
        assert "Opening in MuseScore..." in capsys.readouterr().out

    def test_prints_hint_when_musescore_missing(self, song_file: Path, tmp_path: Path, capsys):
        out = tmp_path / "out.musicxml"
        with (
            patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>"),
            patch("deluge_tools.cli._open_in_musescore", return_value=False),
        ):
            main([str(song_file), "-o", str(out)])
        assert "MuseScore not found" in capsys.readouterr().err

    def test_no_open_flag_skips_musescore(self, song_file: Path, tmp_path: Path):
        out = tmp_path / "out.musicxml"
        with (
            patch("deluge_tools.cli.song_to_musicxml", return_value="<xml/>"),
            patch("deluge_tools.cli._open_in_musescore") as mock_open,
        ):
            main([str(song_file), "-o", str(out), "--no-open"])
        mock_open.assert_not_called()

    def test_non_openable_format_skips_musescore(self, song_file: Path, tmp_path: Path):
        out = tmp_path / "out.ly"
        with (
            patch("deluge_tools.cli.song_to_score", return_value=FakeScore()),
            patch("deluge_tools.cli._open_in_musescore") as mock_open,
        ):
            main([str(song_file), "-o", str(out)])
        mock_open.assert_not_called()
