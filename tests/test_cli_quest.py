"""Tests for the deluge-quest discovery CLI."""

from __future__ import annotations

from importlib.metadata import version as _pkg_version

import pytest

from deluge_tools.cli_quest import main


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit, match="0"):
        main(["--version"])
    assert f"deluge-quest {_pkg_version('deluge-quest')}" in capsys.readouterr().out


def test_version_short(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit, match="0"):
        main(["-V"])
    assert f"deluge-quest {_pkg_version('deluge-quest')}" in capsys.readouterr().out


def test_help_lists_all_tools(capsys: pytest.CaptureFixture[str]) -> None:
    main([])
    out = capsys.readouterr().out
    assert "deluge-backup" in out
    assert "deluge-clean" in out
    assert "deluge-stats" in out
    assert "deluge-score" in out
    assert "deluge-import" in out
    assert "deluge.quest" in out or "deluge-quest" in out


@pytest.mark.parametrize(
    "tool", ["deluge-backup", "deluge-clean", "deluge-stats", "deluge-score", "deluge-import"]
)
def test_each_tool_listed(tool: str, capsys: pytest.CaptureFixture[str]) -> None:
    main([])
    assert tool in capsys.readouterr().out
