from __future__ import annotations

import subprocess
from importlib.metadata import version as _pkg_version
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
        assert _pkg_version("deluge-quest") in capsys.readouterr().out

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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_du", return_value=True),
        ):
            _main(["size"])
        calls = mock_run.call_args_list
        assert any("du" in str(c) for c in calls)
        assert any("rev-list" in str(c) for c in calls)

    def test_size_with_xml_remote(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        mock_run = MagicMock(return_value=subprocess.CompletedProcess([], 0, stdout="50M\t.\n"))
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_du", return_value=True),
        ):
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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
            patch("deluge_tools.cli_backup._has_du", return_value=True),
        ):
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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
            _main(["remote-init", "https://github.com/user/repo.git"])
        calls_str = str(mock_run.call_args_list)
        assert "ls-remote" in calls_str
        assert "git init" in calls_str or "'git', 'init'" in calls_str
        assert "remote" in calls_str
        assert "rsync" in calls_str

    def test_remote_init_clones_when_remote_has_history(
        self, env_vars, card_dir, monkeypatch, capsys
    ):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)

        def side_effect(cmd, **kw):
            if "ls-remote" in cmd:
                return subprocess.CompletedProcess(cmd, 0, stdout="abc123\tHEAD\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="")

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            _main(["remote-init", "https://github.com/user/repo.git"])
        calls_str = str(mock_run.call_args_list)
        assert "clone" in calls_str
        assert "'git', 'init'" not in calls_str
        assert "cloned" in capsys.readouterr().out.lower()

    def test_remote_init_fails_if_remote_unreachable(self, env_vars, card_dir, monkeypatch, capsys):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)

        def side_effect(cmd, **kw):
            if "ls-remote" in cmd:
                return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="fatal: not found")
            return subprocess.CompletedProcess(cmd, 0, stdout="")

        mock_run = MagicMock(side_effect=side_effect)
        with patch("subprocess.run", mock_run):
            with pytest.raises(SystemExit):
                _main(["remote-init", "https://github.com/user/repo.git"])
        calls_str = str(mock_run.call_args_list)
        assert "'git', 'init'" not in calls_str
        assert "'git', 'push'" not in calls_str
        assert "reach" in capsys.readouterr().err.lower()


class TestChangelogAppendOnly:
    def test_readme_excluded_from_xml_sync_patterns(self):
        from deluge_tools.cli_backup import XML_INCLUDE_GLOBS, XML_INCLUDE_PATTERNS

        assert not any("README" in p for p in XML_INCLUDE_PATTERNS)
        assert "README.md" not in XML_INCLUDE_GLOBS

    def test_append_changelog_entry_preserves_existing_history(self, tmp_path):
        from deluge_tools.cli_backup import _append_changelog_entry

        readme = tmp_path / "README.md"
        readme.write_text("# Header\n\n## Changelog\n\n### old entry\n- x\n")
        _append_changelog_entry(readme, "### new entry\n- y", header="# Header")
        text = readme.read_text()
        assert "old entry" in text
        assert "new entry" in text
        assert text.index("new entry") < text.index("old entry")

    def test_push_appends_without_overwriting_remote_readme(self, env_vars, card_dir, monkeypatch):
        for k, v in env_vars.items():
            monkeypatch.setenv(k, v)
        remote_dir = card_dir / ".xml-remote"
        (remote_dir / ".git").mkdir(parents=True)
        readme = remote_dir / "README.md"
        readme.write_text(
            "# Deluge Card XML Backup\n\n## Changelog\n\n### 2026-09-14 — old entry\n- something\n"
        )
        (card_dir / "README.md").write_text("# a completely different local readme\n")

        diff_check = subprocess.CompletedProcess([], 1)
        name_status = subprocess.CompletedProcess([], 0, stdout="M\tSONGS/foo.XML\n")
        default_result = subprocess.CompletedProcess([], 0, stdout="")

        def side_effect(cmd, **kw):
            if "diff" in cmd and "--cached" in cmd and "--quiet" in cmd:
                return diff_check
            if "diff" in cmd and "--cached" in cmd and "--name-status" in cmd:
                return name_status
            return default_result

        mock_run = MagicMock(side_effect=side_effect)
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
            _main(["push", "add a song"])

        text = readme.read_text()
        assert "old entry" in text
        assert "add a song" in text
        assert "a completely different local readme" not in text


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
        with (
            patch("subprocess.run", mock_run),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
        ):
            _main(["push", "xml update"])
        calls_str = str(mock_run.call_args_list)
        assert "rsync" in calls_str
        assert "push" in calls_str
        assert "-u" in calls_str
        assert "origin" in calls_str

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


@pytest.fixture
def env(env_vars, monkeypatch) -> dict[str, str]:
    for k, v in env_vars.items():
        monkeypatch.setenv(k, v)
    return env_vars


@pytest.fixture
def mount(env) -> Path:
    m = Path(env["DELUGE_CARD_MOUNT"])
    (m / "SONGS").mkdir(parents=True)
    (m / "SONGS" / "SONG001.XML").write_text("<song/>")
    return m


class TestIsWsl:
    @pytest.mark.parametrize(
        ("content", "expected"),
        [("Linux version 6.1-microsoft-standard-WSL2", True), ("Linux version 6.1-generic", False)],
    )
    def test_reads_proc_version(self, content: str, expected: bool):
        from deluge_tools.cli_backup import _is_wsl

        with patch("pathlib.Path.read_text", return_value=content):
            assert _is_wsl() is expected

    def test_unreadable_proc_version(self):
        from deluge_tools.cli_backup import _is_wsl

        with patch("pathlib.Path.read_text", side_effect=OSError):
            assert _is_wsl() is False


class TestMountNeedsHelp:
    def test_missing_mount_name(self, tmp_path: Path):
        from deluge_tools.cli_backup import _mount_needs_help

        assert _mount_needs_help(tmp_path / "absent") is False

    def test_iterdir_errors_fall_back_false(self, tmp_path: Path):
        from deluge_tools.cli_backup import _mount_needs_help

        with patch("pathlib.Path.iterdir", side_effect=OSError):
            assert _mount_needs_help(tmp_path / "mnt") is False

    def test_mount_failure_warns(self, tmp_path: Path, capsys):
        from deluge_tools.cli_backup import _ensure_mount

        mount = tmp_path / "mnt"
        mount.mkdir()
        with (
            patch("deluge_tools.cli_backup._is_wsl", return_value=True),
            patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1)),
        ):
            _ensure_mount(mount, "D:")
        assert "mount failed" in capsys.readouterr().err


class TestToolDetection:
    @pytest.mark.parametrize(
        ("side_effect", "expected"),
        [
            (None, True),
            (FileNotFoundError, False),
            (subprocess.CalledProcessError(1, "rsync"), False),
        ],
    )
    def test_has_rsync(self, side_effect, expected: bool):
        from deluge_tools.cli_backup import _has_rsync

        with patch("subprocess.run", side_effect=side_effect):
            assert _has_rsync() is expected

    @pytest.mark.parametrize(
        ("side_effect", "expected"), [(None, True), (FileNotFoundError, False)]
    )
    def test_has_du(self, side_effect, expected: bool):
        from deluge_tools.cli_backup import _has_du

        with patch("subprocess.run", side_effect=side_effect):
            assert _has_du() is expected


class TestGetDirSize:
    def test_du_empty_output(self, tmp_path: Path):
        from deluge_tools.cli_backup import _get_dir_size

        with (
            patch("deluge_tools.cli_backup._has_du", return_value=True),
            patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout="")),
        ):
            assert _get_dir_size(tmp_path) == "?"

    def test_du_passes_excludes(self, tmp_path: Path):
        from deluge_tools.cli_backup import _get_dir_size

        result = subprocess.CompletedProcess([], 0, stdout="12M\t.\n")
        with (
            patch("deluge_tools.cli_backup._has_du", return_value=True),
            patch("subprocess.run", return_value=result) as mock_run,
        ):
            assert _get_dir_size(tmp_path, excludes=[".git"]) == "12M"
        assert "--exclude=.git" in mock_run.call_args.args[0]

    def test_python_fallback(self, tmp_path: Path):
        from deluge_tools.cli_backup import _get_dir_size

        (tmp_path / "a").write_bytes(b"x" * 10)
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "big").write_bytes(b"x" * 5000)
        with patch("deluge_tools.cli_backup._has_du", return_value=False):
            assert _get_dir_size(tmp_path, excludes=[".git"]) == "10B"


class TestInitWithoutRsync:
    def test_copies_with_sync_tree(self, tmp_path: Path, monkeypatch):
        src = tmp_path / "src"
        (src / "SONGS").mkdir(parents=True)
        (src / "SONGS" / "A.XML").write_text("<song/>")
        dest = tmp_path / "card"
        monkeypatch.setenv("DELUGE_CARD_DIR", str(dest))
        with (
            patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout="1")),
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._has_du", return_value=False),
        ):
            _main(["init", str(src)])
        assert (dest / "SONGS" / "A.XML").read_text() == "<song/>"
        assert (dest / ".gitattributes").read_text() == "* -text\n"


class TestSyncOutput:
    @pytest.mark.parametrize(
        ("status_out", "expected"),
        [
            ("", "No changes"),
            (" M SONGS/A.XML\n", "M SONGS/A.XML"),
            ("".join(f"?? F{i}\n" for i in range(13)), "13 files changed"),
        ],
    )
    def test_rsync_go_summarizes(self, card_dir, mount, capsys, status_out: str, expected: str):
        result = subprocess.CompletedProcess([], 0, stdout=status_out)
        with (
            patch("subprocess.run", return_value=result),
            patch("deluge_tools.cli_backup._has_rsync", return_value=True),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync", "--go"])
        assert expected in capsys.readouterr().out

    def test_mount_iterdir_error_exits(self, card_dir, env, capsys):
        with (
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
            patch("pathlib.Path.iterdir", side_effect=OSError),
            patch("pathlib.Path.is_dir", return_value=True),
        ):
            with pytest.raises(SystemExit):
                _main(["sync"])
        assert "SD card not found" in capsys.readouterr().err

    def test_python_dry_run_lists_without_copying(self, card_dir, mount, capsys):
        with (
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync"])
        out = capsys.readouterr().out
        assert "DRY RUN" in out
        assert "copy SONGS/SONG001.XML" in out
        assert not (card_dir / "SONGS").exists()

    def test_python_dry_run_no_changes(self, card_dir, env, capsys):
        m = Path(env["DELUGE_CARD_MOUNT"])
        m.mkdir()
        (m / "SYSTEM").mkdir()
        (card_dir / "SYSTEM").mkdir()
        with (
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync"])
        assert "No changes" in capsys.readouterr().out

    def test_python_go_copies(self, card_dir, mount, capsys):
        with (
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync", "--go"])
        assert (card_dir / "SONGS" / "SONG001.XML").exists()
        assert "copy SONGS/SONG001.XML" in capsys.readouterr().out

        with (
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync", "--go"])
        assert "No changes" in capsys.readouterr().out

    def test_python_go_many_changes(self, card_dir, mount, capsys):
        for i in range(13):
            (mount / "SONGS" / f"S{i}.XML").write_text("x")
        with (
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
            patch("deluge_tools.cli_backup._is_wsl", return_value=False),
        ):
            _main(["sync", "--go"])
        assert "14 files changed" in capsys.readouterr().out


class TestChangelogFormatting:
    @pytest.mark.parametrize(
        ("status", "f1", "f2", "prefix", "expected"),
        [
            ("A", "SONGS/A.XML", "", "", "- Added `SONGS/A.XML`"),
            ("R100", "a", "b", "", "- Renamed `a` → `b`"),
            ("R090", "SAMPLES/a.wav", "SAMPLES/b.wav", "SAMPLES/", "  - renamed `a.wav` → `b.wav`"),
            ("X", "f", "", "", "- X `f`"),
        ],
    )
    def test_format_change(self, status: str, f1: str, f2: str, prefix: str, expected: str):
        from deluge_tools.cli_backup import _format_change

        assert _format_change(status, f1, f2, prefix) == expected

    def test_entry_lists_sample_changes(self):
        from deluge_tools.cli_backup import _build_changelog_entry

        entry = _build_changelog_entry("A\tSAMPLES/kick.wav\nM\tSONGS/A.XML\n", "msg")
        assert "- **Samples:**" in entry
        assert "  - added `kick.wav`" in entry
        assert "- Modified `SONGS/A.XML`" in entry

    def test_entry_summarizes_many_changes(self):
        from deluge_tools.cli_backup import _build_changelog_entry

        entry = _build_changelog_entry("".join(f"M\tSONGS/{i}.XML\n" for i in range(13)), "msg")
        assert "13 files changed (too many to list individually)" in entry
        assert "- No sample changes." in entry


class TestReadText:
    def test_falls_back_to_cp1252(self, tmp_path: Path):
        from deluge_tools.cli_backup import _read_text

        p = tmp_path / "README.md"
        p.write_bytes("café".encode("cp1252"))
        assert _read_text(p) == "café"


class TestRemoteInitExtras:
    def test_reports_current_remote(self, card_dir, env, capsys):
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        current = subprocess.CompletedProcess([], 0, stdout="git@github.com:u/r.git\n")
        with patch("subprocess.run", return_value=current):
            with pytest.raises(SystemExit):
                _main(["remote-init", "https://github.com/user/repo.git"])
        assert "Current remote: git@github.com:u/r.git" in capsys.readouterr().err

    def test_without_rsync_copies_xml_only(self, card_dir, env):
        (card_dir / "SONGS").mkdir()
        (card_dir / "SONGS" / "A.XML").write_text("<song/>")
        (card_dir / "SAMPLES").mkdir()
        (card_dir / "SAMPLES" / "k.wav").write_bytes(b"RIFF")
        with (
            patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout="")),
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
        ):
            _main(["remote-init", "https://github.com/user/repo.git"])
        remote = card_dir / ".xml-remote"
        assert (remote / "SONGS" / "A.XML").exists()
        assert not (remote / "SAMPLES" / "k.wav").exists()


class TestPushWithoutRsync:
    def test_copies_xml_with_sync_tree(self, card_dir, env):
        (card_dir / ".xml-remote" / ".git").mkdir(parents=True)
        (card_dir / "SONGS").mkdir()
        (card_dir / "SONGS" / "A.XML").write_text("<song/>")

        def side_effect(cmd, **kw):
            if "--quiet" in cmd:
                return subprocess.CompletedProcess(cmd, 1)
            return subprocess.CompletedProcess(cmd, 0, stdout="")

        with (
            patch("subprocess.run", side_effect=side_effect),
            patch("deluge_tools.cli_backup._has_rsync", return_value=False),
        ):
            _main(["push", "msg"])
        assert (card_dir / ".xml-remote" / "SONGS" / "A.XML").exists()


class TestOpenBrowserSafety:
    @pytest.mark.parametrize("url", ["file:///etc/passwd", "https://x.com/a&calc", "javascript:1"])
    def test_refuses_suspicious_urls(self, url: str, capsys):
        from deluge_tools.cli_backup import _open_browser

        with patch("subprocess.run") as mock_run, patch("webbrowser.open") as mock_open:
            _open_browser(url)
        mock_run.assert_not_called()
        mock_open.assert_not_called()
        assert "refusing" in capsys.readouterr().err
