from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from deluge_tools.card_scanner import (
    find_all_samples,
    scan_card,
    scan_xml_references,
)


@pytest.fixture
def card_root(tmp_path: Path) -> Path:
    """Create a minimal Deluge SD card structure."""
    (tmp_path / "SONGS").mkdir()
    (tmp_path / "KITS").mkdir()
    (tmp_path / "SYNTHS").mkdir()
    (tmp_path / "SAMPLES" / "RECORD").mkdir(parents=True)
    (tmp_path / "SAMPLES" / "Kicks").mkdir(parents=True)
    return tmp_path


def _write_xml(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content).strip())


class TestScanXmlReferences:
    def test_finds_filename_attributes(self, card_root: Path):
        _write_xml(
            card_root / "SONGS" / "SONG001.XML",
            """
            <song firmwareVersion="4.1.4">
              <sound>
                <osc1 fileName="SAMPLES/RECORD/REC00001.WAV" />
                <osc2 fileName="SAMPLES/Kicks/kick.wav" />
              </sound>
            </song>
        """,
        )
        refs = scan_xml_references(card_root)
        assert "SAMPLES/RECORD/REC00001.WAV" in refs
        assert "SAMPLES/Kicks/kick.wav" in refs

    def test_finds_filepath_attributes(self, card_root: Path):
        _write_xml(
            card_root / "KITS" / "KIT001.XML",
            """
            <kit>
              <soundSources>
                <sound>
                  <osc1 filePath="SAMPLES/RECORD/REC00002.WAV" />
                </sound>
              </soundSources>
            </kit>
        """,
        )
        refs = scan_xml_references(card_root)
        assert "SAMPLES/RECORD/REC00002.WAV" in refs

    def test_scans_all_three_folders(self, card_root: Path):
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/a.wav" /></song>
        """,
        )
        _write_xml(
            card_root / "KITS" / "K.XML",
            """
            <kit><osc fileName="SAMPLES/b.wav" /></kit>
        """,
        )
        _write_xml(
            card_root / "SYNTHS" / "Y.XML",
            """
            <synth><osc fileName="SAMPLES/c.wav" /></synth>
        """,
        )
        refs = scan_xml_references(card_root)
        assert refs == {"SAMPLES/a.wav", "SAMPLES/b.wav", "SAMPLES/c.wav"}

    def test_skips_malformed_xml(self, card_root: Path, capsys):
        (card_root / "SONGS" / "BAD.XML").write_text("not xml at all <<<")
        refs = scan_xml_references(card_root)
        assert refs == set()

    def test_handles_empty_folders(self, card_root: Path):
        refs = scan_xml_references(card_root)
        assert refs == set()

    def test_deduplicates(self, card_root: Path):
        _write_xml(
            card_root / "SONGS" / "S1.XML",
            """
            <song><osc fileName="SAMPLES/x.wav" /></song>
        """,
        )
        _write_xml(
            card_root / "SONGS" / "S2.XML",
            """
            <song><osc fileName="SAMPLES/x.wav" /></song>
        """,
        )
        refs = scan_xml_references(card_root)
        assert refs == {"SAMPLES/x.wav"}

    def test_case_insensitive_xml_extension(self, card_root: Path):
        _write_xml(
            card_root / "SONGS" / "song.xml",
            """
            <song><osc fileName="SAMPLES/low.wav" /></song>
        """,
        )
        refs = scan_xml_references(card_root)
        assert "SAMPLES/low.wav" in refs


class TestFindAllSamples:
    def test_finds_files_recursively(self, card_root: Path):
        (card_root / "SAMPLES" / "RECORD" / "REC001.WAV").touch()
        (card_root / "SAMPLES" / "Kicks" / "kick.wav").touch()
        samples = find_all_samples(card_root)
        assert "SAMPLES/RECORD/REC001.WAV" in samples
        assert "SAMPLES/Kicks/kick.wav" in samples

    def test_ignores_non_audio_files(self, card_root: Path):
        (card_root / "SAMPLES" / "readme.txt").touch()
        (card_root / "SAMPLES" / "RECORD" / "REC001.WAV").touch()
        samples = find_all_samples(card_root)
        assert "SAMPLES/RECORD/REC001.WAV" in samples
        assert not any("readme" in s for s in samples)

    def test_empty_samples_dir(self, card_root: Path):
        assert find_all_samples(card_root) == {}


class TestScanCard:
    def test_identifies_unused_samples(self, card_root: Path):
        (card_root / "SAMPLES" / "RECORD" / "USED.WAV").touch()
        (card_root / "SAMPLES" / "RECORD" / "UNUSED.WAV").touch()
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/USED.WAV" /></song>
        """,
        )
        report = scan_card(card_root)
        assert "SAMPLES/RECORD/UNUSED.WAV" in report.unused_samples
        assert "SAMPLES/RECORD/USED.WAV" not in report.unused_samples

    def test_identifies_missing_references(self, card_root: Path):
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/GONE.WAV" /></song>
        """,
        )
        report = scan_card(card_root)
        assert "SAMPLES/RECORD/GONE.WAV" in report.missing_references

    def test_identifies_unused_presets(self, card_root: Path):
        _write_xml(
            card_root / "KITS" / "USED.XML",
            """
            <kit><osc fileName="SAMPLES/x.wav" /></kit>
        """,
        )
        _write_xml(
            card_root / "KITS" / "ORPHAN.XML",
            """
            <kit><osc fileName="SAMPLES/y.wav" /></kit>
        """,
        )
        _write_xml(
            card_root / "SYNTHS" / "LONELY.XML",
            """
            <synth><osc fileName="SAMPLES/z.wav" /></synth>
        """,
        )
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song>
              <instruments>
                <kit presetSlot="0" presetName="USED" />
              </instruments>
            </song>
        """,
        )
        report = scan_card(card_root)
        assert "KITS/ORPHAN.XML" in report.unused_presets
        assert "SYNTHS/LONELY.XML" in report.unused_presets
        assert "KITS/USED.XML" not in report.unused_presets

    def test_report_reclaimable_bytes(self, card_root: Path):
        unused = card_root / "SAMPLES" / "RECORD" / "BIG.WAV"
        unused.write_bytes(b"\x00" * 1024)
        report = scan_card(card_root)
        assert report.reclaimable_bytes >= 1024

    def test_all_used_report(self, card_root: Path):
        (card_root / "SAMPLES" / "RECORD" / "A.WAV").touch()
        _write_xml(
            card_root / "SONGS" / "S.XML",
            """
            <song><osc fileName="SAMPLES/RECORD/A.WAV" /></song>
        """,
        )
        report = scan_card(card_root)
        assert len(report.unused_samples) == 0
        assert len(report.missing_references) == 0

    def test_validates_card_structure(self, tmp_path: Path):
        with pytest.raises(ValueError, match="SAMPLES"):
            scan_card(tmp_path)
