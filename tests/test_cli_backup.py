from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def card_dir(tmp_path: Path) -> Path:
    repo = tmp_path / "deluge-card"
    repo.mkdir()
    (repo / ".git").mkdir()
    return repo


@pytest.fixture
def env_vars(card_dir: Path, tmp_path: Path) -> dict[str, str]:
    return {
        "DELUGE_CARD_DIR": str(card_dir),
        "DELUGE_CARD_MOUNT": str(tmp_path / "mnt"),
        "DELUGE_CARD_DRIVE": "D:",
    }


def _main(argv: list[str] | None = None) -> None:
    from deluge_tools.cli_backup import main

    main(argv)


class TestVersion:
    def test_version_flag(self, capsys):
        with pytest.raises(SystemExit, match="0"):
            _main(["--version"])
        assert "0.1.0" in capsys.readouterr().out

    def test_help_flag(self, capsys):
        with pytest.raises(SystemExit, match="0"):
            _main(["--help"])
        out = capsys.readouterr().out
        assert "status" in out
        assert "diff" in out
        assert "log" in out
        assert "size" in out


class TestStatus:
    def test_runs_git_status(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0))
        with patch("subprocess.run", mock_run):
            _main(["status"])
        mock_run.assert_called_once_with(
            ["git", "status"],
            cwd=card_dir,
            check=False,
        )

    def test_no_repo_exits(self, tmp_path, monkeypatch):
        no_repo = tmp_path / "empty"
        no_repo.mkdir()
        monkeypatch.setenv("DELUGE_CARD_DIR", str(no_repo))
        with pytest.raises(SystemExit):
            _main(["status"])


class TestDiff:
    def test_runs_git_diff(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0))
        with patch("subprocess.run", mock_run):
            _main(["diff"])
        mock_run.assert_called_once_with(
            ["git", "diff"],
            cwd=card_dir,
            check=False,
        )


class TestLog:
    def test_runs_git_log(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0))
        with patch("subprocess.run", mock_run):
            _main(["log"])
        mock_run.assert_called_once_with(
            ["git", "log", "--oneline", "--graph", "-20"],
            cwd=card_dir,
            check=False,
        )


class TestSize:
    def test_runs_size_commands(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout="100M\t.\n"))
        with patch("subprocess.run", mock_run):
            _main(["size"])
        calls = mock_run.call_args_list
        assert any("du" in str(c) for c in calls)
        assert any("rev-list" in str(c) for c in calls)

    def test_size_with_xml_remote(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout="50M\t.\n"))
        with patch("subprocess.run", mock_run):
            _main(["size"])
        calls_str = str(mock_run.call_args_list)
        assert ".xml-remote" in calls_str


class TestInit:
    def test_fails_if_repo_exists(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(SystemExit):
            _main(["init"])
        assert "already exists" in capsys.readouterr().err

    def test_fails_if_source_missing(self, tmp_path, monkeypatch, capsys):
        card_dir = tmp_path / "new-card"
        monkeypatch.setenv("DELUGE_CARD_DIR", str(card_dir))
        monkeypatch.setenv("DELUGE_CARD_MOUNT", str(tmp_path / "no-such-mount"))
        with pytest.raises(SystemExit):
            _main(["init"])
        assert "not found" in capsys.readouterr().err.lower()

    def test_init_from_source(self, tmp_path, monkeypatch):
        card_dir = tmp_path / "new-card"
        source = tmp_path / "source"
        source.mkdir()
        (source / "SONGS").mkdir()
        monkeypatch.setenv("DELUGE_CARD_DIR", str(card_dir))
        monkeypatch.setenv("DELUGE_CARD_MOUNT", str(tmp_path / "no-mount"))
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout=""))
        with patch("subprocess.run", mock_run):
            _main(["init", str(source)])
        calls_str = str(mock_run.call_args_list)
        assert "rsync" in calls_str
        assert "git init" in calls_str or "'git', 'init'" in calls_str


class TestSync:
    def test_dry_run_by_default(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mount = Path(env_vars["DELUGE_CARD_MOUNT"])
        mount.mkdir(parents=True, exist_ok=True)
        (mount / "SONGS").mkdir()
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout=""))
        with patch("subprocess.run", mock_run):
            _main(["sync"])
        rsync_call = mock_run.call_args_list[0]
        assert "-avn" in rsync_call.args[0] or any("-avn" in str(a) for a in rsync_call.args[0])

    def test_go_flag_applies(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mount = Path(env_vars["DELUGE_CARD_MOUNT"])
        mount.mkdir(parents=True, exist_ok=True)
        (mount / "SONGS").mkdir()
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout=""))
        with patch("subprocess.run", mock_run):
            _main(["sync", "--go"])
        rsync_call = mock_run.call_args_list[0]
        cmd = rsync_call.args[0]
        assert "-av" in cmd
        assert "-avn" not in cmd

    def test_no_repo_exits(self, tmp_path, monkeypatch):
        no_repo = tmp_path / "empty"
        no_repo.mkdir()
        monkeypatch.setenv("DELUGE_CARD_DIR", str(no_repo))
        monkeypatch.setenv("DELUGE_CARD_MOUNT", str(tmp_path / "mnt"))
        (tmp_path / "mnt").mkdir()
        with pytest.raises(SystemExit):
            _main(["sync"])

    def test_no_mount_exits(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(SystemExit):
            _main(["sync"])


class TestCommit:
    def test_commit_calls_git(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        diff_result = subprocess.CompletedProcess([], 1)
        status_result = subprocess.CompletedProcess([], 0, stdout="M\tSONGS/A.XML\n")
        default_result = subprocess.CompletedProcess([], 0, stdout="")

        def side_effect(cmd, **kw):
            if cmd[:2] == ["git", "diff"] and "--quiet" in cmd:
                return diff_result
            if cmd[:2] == ["git", "diff"] and "--cached" in cmd and "--name-status" in cmd:
                return status_result
            return default_result

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            _main(["commit", "test snapshot"])
        calls_str = str(mock_run.call_args_list)
        assert "commit" in calls_str
        assert "test snapshot" in calls_str

    def test_commit_nothing_exits_clean(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        clean_result = subprocess.CompletedProcess([], 0, stdout="")

        def side_effect(cmd, **kw):
            if "--quiet" in cmd:
                return clean_result
            if "ls-files" in cmd:
                return clean_result
            return clean_result

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            _main(["commit"])
        out = capsys.readouterr().out
        assert "clean" in out.lower() or "nothing" in out.lower()


class TestSave:
    def test_save_calls_sync_and_commit(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mount = Path(env_vars["DELUGE_CARD_MOUNT"])
        mount.mkdir(parents=True, exist_ok=True)
        (mount / "SONGS").mkdir()
        diff_result = subprocess.CompletedProcess([], 1)
        status_result = subprocess.CompletedProcess([], 0, stdout="M\tSONGS/A.XML\n")
        default_result = subprocess.CompletedProcess([], 0, stdout="")

        def side_effect(cmd, **kw):
            if cmd[:2] == ["git", "diff"] and "--quiet" in cmd:
                return diff_result
            if cmd[:2] == ["git", "diff"] and "--cached" in cmd and "--name-status" in cmd:
                return status_result
            return default_result

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            _main(["save", "session save"])
        calls_str = str(mock_run.call_args_list)
        assert "rsync" in calls_str
        assert "commit" in calls_str


class TestRemoteInit:
    def test_requires_url(self, capsys):
        with pytest.raises(SystemExit):
            _main(["remote-init"])

    def test_fails_if_remote_exists(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        with pytest.raises(SystemExit):
            _main(["remote-init", "https://github.com/user/repo.git"])
        assert "already exists" in capsys.readouterr().err

    def test_remote_init_runs_commands(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout=""))
        with patch("subprocess.run", mock_run):
            _main(["remote-init", "https://github.com/user/repo.git"])
        calls_str = str(mock_run.call_args_list)
        assert "git init" in calls_str or "'git', 'init'" in calls_str
        assert "remote" in calls_str
        assert "rsync" in calls_str


class TestPush:
    def test_fails_if_no_remote(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(SystemExit):
            _main(["push"])
        assert "no xml remote" in capsys.readouterr().err.lower()

    def test_push_syncs_and_pushes(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        diff_result = subprocess.CompletedProcess([], 1)
        default_result = subprocess.CompletedProcess([], 0, stdout="")

        def side_effect(cmd, **kw):
            if "diff" in cmd and "--cached" in cmd and "--quiet" in cmd:
                return diff_result
            return default_result

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            _main(["push", "xml update"])
        calls_str = str(mock_run.call_args_list)
        assert "rsync" in calls_str
        assert "push" in calls_str

    def test_push_no_changes_exits_clean(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        clean_result = subprocess.CompletedProcess([], 0, stdout="")
        mock_run = MagicMock(return_value=clean_result)
        with patch("subprocess.run", mock_run):
            _main(["push"])
        out = capsys.readouterr().out
        assert "no xml changes" in out.lower()


class TestOpen:
    def test_fails_if_no_remote(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(SystemExit):
            _main(["open"])
        assert "no xml remote" in capsys.readouterr().err.lower()

    def test_opens_https_url_on_non_wsl(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        remote_result = subprocess.CompletedProcess(
            [], 0, stdout="https://github.com/user/repo.git\n"
        )
        mock_run = MagicMock(return_value=remote_result)
        mock_open = MagicMock()
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
            patch("webbrowser.open", mock_open),
        ):
            _main(["open"])
        mock_open.assert_called_once_with("https://github.com/user/repo")
        assert "https://github.com/user/repo" in capsys.readouterr().out

    def test_opens_via_cmd_exe_on_wsl(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        remote_result = subprocess.CompletedProcess([], 0, stdout="git@github.com:user/repo.git\n")
        mock_run = MagicMock(return_value=remote_result)
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._is_wsl", return_value=True),
        ):
            _main(["open"])
        calls_str = str(mock_run.call_args_list)
        assert "cmd.exe" in calls_str
        assert "https://github.com/user/repo" in calls_str

    def test_fails_if_no_remote_url(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 1, stdout=""))
        with patch("subprocess.run", mock_run):
            with pytest.raises(SystemExit):
                _main(["open"])
        assert "no remote url" in capsys.readouterr().err.lower()


class TestWslMount:
    def test_attempts_mount_on_wsl_when_empty(self, tmp_path):
        from deluge_tools.cli_backup import _ensure_mount

        mount = tmp_path / "mnt"
        mount.mkdir()
        with (
            patch("deluge_tools.cli_backup._is_wsl", return_value=True),
            patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as mock_run,
        ):
            _ensure_mount(mount, "D:")
        mock_run.assert_called_once()
        assert "drvfs" in mock_run.call_args.args[0]

    def test_skips_mount_on_non_wsl(self, tmp_path):
        from deluge_tools.cli_backup import _ensure_mount

        mount = tmp_path / "mnt"
        mount.mkdir()
        with (
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
            patch("subprocess.run") as mock_run,
        ):
            _ensure_mount(mount, "D:")
        mock_run.assert_not_called()

    def test_skips_mount_when_dir_has_content(self, tmp_path):
        from deluge_tools.cli_backup import _ensure_mount

        mount = tmp_path / "mnt"
        mount.mkdir()
        (mount / "SONGS").mkdir()
        with (
            patch("deluge_tools.cli_backup._is_wsl", return_value=True),
            patch("subprocess.run") as mock_run,
        ):
            _ensure_mount(mount, "D:")
        mock_run.assert_not_called()


class TestNoArgs:
    def test_no_subcommand_shows_help(self):
        with pytest.raises(SystemExit):
            _main([])
