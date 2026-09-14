---
title: "MIDI channel selection: AND/OR + ONLY toggle"
date: 2026-09-14
tag: feature
---

I was using the [Card Management](/manage) for its intended purpose of helping me organize some of my Deluge songs.

The goal was to isolate tracks that use MIDI channels of gear I don't have anymore. For example, I have a bunch of tracks on MIDI channel 11, which I *believe* was a Korg Minilogue XD I used to own. I don't own that anymore, nor am I currently using channel 11, so I wanted to isolate those tracks for re-patching.

Sorting through a *lot* of tracks, I realized that I have a bunch of tracks for solo Novation Peak that could go in their own folder. However, the AND/OR logic of the MIDI channel filter, I realized, was not sufficient for this purpose.

To that end, the MIDI importer's channel selection now supports the preexisting AND/OR logic *plus* an ONLY toggle, so you can narrow multi-channel MIDI files down to exactly the tracks you want before converting. Note that this ignores Deluge internal tracks (synths, kits, and audio channels) and only applies to MIDI tracks.
