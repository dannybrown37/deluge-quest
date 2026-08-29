from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from deluge_tools.cli_stats import _browse_for_folder, _prompt_for_path


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
