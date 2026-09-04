from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from deluge_tools.cli_stats import (
    SongStats,
    _analyze_file,
    _browse_for_folder,
    _collect_songs,
    _is_app_managed,
    _is_deluge_xml,
    _print_summary,
    _print_table,
    _prompt_for_path,
    main,
)

SAMPLE_SONG = Path(__file__).parent / "fixtures" / "square_spelunking.XML"


class TestBrowseForFolder:
    def test_returns_none_without_powershell(self):
        with patch("shutil.which", return_value=None):
            assert _browse_for_folder() is None

    def test_returns_path_on_success(self, tmp_path: Path):
        wsl_path = str(tmp_path)
        with (
            patch("shutil.which", return_value="powershell.exe"),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.side_effect = [
                type("R", (), {"returncode": 0, "stdout": "C:\\Users\\danny\\Music\n"})(),
                type("R", (), {"returncode": 0, "stdout": f"{wsl_path}\n"})(),
            ]
            result = _browse_for_folder()
        assert result == tmp_path

    def test_returns_none_on_cancel(self):
        with (
            patch("shutil.which", return_value="powershell.exe"),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = type("R", (), {"returncode": 1, "stdout": ""})()
            assert _browse_for_folder() is None

    def test_returns_none_on_empty_selection(self):
        with (
            patch("shutil.which", return_value="powershell.exe"),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = type("R", (), {"returncode": 0, "stdout": "  \n"})()
            assert _browse_for_folder() is None

    def test_returns_none_when_wslpath_fails(self):
        with (
            patch("shutil.which", return_value="powershell.exe"),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.side_effect = [
                type("R", (), {"returncode": 0, "stdout": "C:\\Users\\danny\\Music\n"})(),
                type("R", (), {"returncode": 1, "stdout": ""})(),
            ]
            assert _browse_for_folder() is None


@pytest.fixture()
def _fake_tty():
    with patch("sys.stdin") as mock_stdin:
        mock_stdin.isatty.return_value = True
        yield


@pytest.mark.usefixtures("_fake_tty")
class TestPromptForPath:
    def test_uses_folder_picker(self, tmp_path: Path):
        with patch("deluge_tools.cli_stats._browse_for_folder", return_value=tmp_path):
            result = _prompt_for_path()
        assert result == tmp_path

    def test_falls_back_to_input_on_cancel(self, tmp_path: Path):
        with (
            patch("deluge_tools.cli_stats._browse_for_folder", return_value=None),
            patch("builtins.input", return_value=str(tmp_path)),
        ):
            result = _prompt_for_path()
        assert result == tmp_path

    def test_not_a_tty_raises(self):
        with patch("sys.stdin") as mock_stdin:
            mock_stdin.isatty.return_value = False
            with pytest.raises(SystemExit):
                _prompt_for_path()

    def test_falls_back_to_input_when_selection_missing(self, tmp_path: Path):
        ghost = tmp_path / "does-not-exist"
        with (
            patch("deluge_tools.cli_stats._browse_for_folder", return_value=ghost),
            patch("builtins.input", return_value=str(tmp_path)),
        ):
            result = _prompt_for_path()
        assert result == tmp_path

    def test_input_path_missing_exits(self, tmp_path: Path, capsys):
        ghost = tmp_path / "does-not-exist"
        with (
            patch("deluge_tools.cli_stats._browse_for_folder", return_value=None),
            patch("builtins.input", return_value=str(ghost)),
            pytest.raises(SystemExit) as exc,
        ):
            _prompt_for_path()
        assert exc.value.code == 1
        assert "does not exist" in capsys.readouterr().err


class TestIsAppManaged:
    @pytest.mark.parametrize(
        "path",
        [
            Path("/card/SOFT_DELETE/foo.xml"),
            Path("/card/REPAIR_BACKUP/foo.xml"),
            Path("/card/soft_delete/foo.xml"),
            Path("SOFT_DELETE/nested/foo.xml"),
        ],
    )
    def test_detects_managed_dirs(self, path: Path):
        assert _is_app_managed(path) is True

    def test_ignores_normal_paths(self):
        assert _is_app_managed(Path("/card/SONGS/foo.xml")) is False


class TestCollectSongs:
    def test_collects_xml_from_directory(self, tmp_path: Path):
        (tmp_path / "a.XML").write_text("<song/>")
        (tmp_path / "b.xml").write_text("<song/>")
        (tmp_path / "c.txt").write_text("not xml")
        result = _collect_songs([tmp_path])
        assert {p.name for p in result} == {"a.XML", "b.xml"}

    def test_includes_direct_file_path(self, tmp_path: Path):
        f = tmp_path / "song.XML"
        f.write_text("<song/>")
        assert _collect_songs([f]) == [f]

    def test_excludes_app_managed_dirs(self, tmp_path: Path):
        managed = tmp_path / "SOFT_DELETE"
        managed.mkdir()
        (managed / "trashed.XML").write_text("<song/>")
        (tmp_path / "kept.XML").write_text("<song/>")
        result = _collect_songs([tmp_path])
        assert [p.name for p in result] == ["kept.XML"]

    def test_ignores_nonexistent_path(self, tmp_path: Path):
        assert _collect_songs([tmp_path / "missing"]) == []


class TestIsDelugeXml:
    def test_true_for_song_root(self):
        assert _is_deluge_xml(SAMPLE_SONG) is True

    def test_false_for_other_root(self, tmp_path: Path):
        f = tmp_path / "other.xml"
        f.write_text("<kit></kit>")
        assert _is_deluge_xml(f) is False

    def test_false_for_malformed_xml(self, tmp_path: Path):
        f = tmp_path / "broken.xml"
        f.write_text("not xml at all")
        assert _is_deluge_xml(f) is False


class TestAnalyzeFile:
    def test_returns_none_for_non_deluge_xml(self, tmp_path: Path):
        f = tmp_path / "other.xml"
        f.write_text("<kit></kit>")
        assert _analyze_file(f) is None

    def test_returns_stats_for_valid_song(self):
        stats = _analyze_file(SAMPLE_SONG)
        assert stats is not None
        assert stats.filename == SAMPLE_SONG.name

    def test_returns_none_and_prints_skip_on_parse_error(self, capsys):
        with patch("deluge_tools.cli_stats.parse_song", side_effect=ValueError("bad song")):
            result = _analyze_file(SAMPLE_SONG)
        assert result is None
        err = capsys.readouterr().err
        assert "SKIP" in err
        assert "bad song" in err


def _make_stats(**overrides: Any) -> SongStats:
    base = SongStats(
        filename="song.XML",
        bpm=120.0,
        key="C major",
        has_arrangement=True,
        instrument_count=2,
        clip_count=3,
        total_notes=100,
        arrangement_length_ticks=1000,
        duration_str="0:10",
    )
    return replace(base, **overrides)


class TestPrintTable:
    def test_prints_header_and_rows(self, capsys):
        stats = [_make_stats(filename="b.XML", bpm=90), _make_stats(filename="a.XML", bpm=150)]
        _print_table(stats, "name")
        out = capsys.readouterr().out
        assert "Song" in out and "BPM" in out
        assert out.index("a") < out.index("b")

    @pytest.mark.parametrize("sort_by", ["name", "bpm", "key", "duration", "notes", "instruments"])
    def test_sorts_by_each_field(self, capsys, sort_by: str):
        stats = [_make_stats(filename="a.XML"), _make_stats(filename="b.XML")]
        _print_table(stats, sort_by)
        assert capsys.readouterr().out

    def test_unknown_sort_falls_back_to_name(self, capsys):
        stats = [_make_stats(filename="b.XML"), _make_stats(filename="a.XML")]
        _print_table(stats, "bogus")
        out = capsys.readouterr().out
        assert out.index("a") < out.index("b")

    def test_no_arrangement_shows_dash_duration(self, capsys):
        stats = [_make_stats(has_arrangement=False)]
        _print_table(stats, "name")
        out = capsys.readouterr().out
        assert "-" in out


class TestPrintSummary:
    def test_prints_summary_for_songs(self, capsys):
        stats = [_make_stats(key="C major"), _make_stats(key="C major"), _make_stats(key="A minor")]
        _print_summary(stats)
        out = capsys.readouterr().out
        assert "3 songs" in out
        assert "With arrangement: 3/3" in out
        assert "BPM range" in out
        assert "Top keys" in out

    def test_handles_empty_list(self, capsys):
        _print_summary([])
        out = capsys.readouterr().out
        assert "0 songs" in out
        assert "BPM range" not in out
        assert "Top keys" not in out


class TestMain:
    def test_version(self, capsys):
        with pytest.raises(SystemExit, match="0"):
            main(["--version"])
        assert capsys.readouterr().out

    def test_no_paths_no_tty_prints_help(self, capsys):
        with patch("sys.stdin") as mock_stdin:
            mock_stdin.isatty.return_value = False
            with pytest.raises(SystemExit) as exc:
                main([])
        assert exc.value.code == 1
        assert "usage" in capsys.readouterr().out.lower()

    def test_no_paths_prompts_when_tty(self, tmp_path: Path, capsys):
        f = tmp_path / "song.XML"
        f.write_text(SAMPLE_SONG.read_text())
        with (
            patch("sys.stdin") as mock_stdin,
            patch("deluge_tools.cli_stats._prompt_for_path", return_value=tmp_path),
        ):
            mock_stdin.isatty.return_value = True
            main([])
        out = capsys.readouterr().out
        assert "song" in out

    def test_no_xml_files_found_exits(self, tmp_path: Path, capsys):
        with pytest.raises(SystemExit) as exc:
            main([str(tmp_path)])
        assert exc.value.code == 1
        assert "No .XML files found" in capsys.readouterr().err

    def test_no_valid_songs_exits(self, tmp_path: Path, capsys):
        f = tmp_path / "bad.XML"
        f.write_text("<kit></kit>")
        with pytest.raises(SystemExit) as exc:
            main([str(tmp_path)])
        assert exc.value.code == 1
        assert "No valid songs found" in capsys.readouterr().err

    def test_successful_run_prints_table_and_summary(self, capsys):
        main([str(SAMPLE_SONG)])
        out = capsys.readouterr().out
        assert "Song" in out
        assert "Summary" in out

    def test_no_summary_flag_skips_summary(self, capsys):
        main([str(SAMPLE_SONG), "--no-summary"])
        out = capsys.readouterr().out
        assert "Song" in out
        assert "Summary" not in out

    def test_sort_flag_applied(self, capsys):
        main([str(SAMPLE_SONG), "--sort", "bpm"])
        assert "Song" in capsys.readouterr().out
