---
title: "deluge-backup: Windows support"
date: 2026-09-14
tag: feature
---

At first, I deferred Windows support until such a time as it was requested. I'm a WSL true-blue so I didn't think I'd need Windows support personally.

Then I realized -- while my programming work is all in WSL, I still browse in Windows. That means I'm accessing [deluge.quest](https://deluge.quest) in Windows, and I realized that when I load in the WSL-based backup on the Windws side, it's significantly slower due to the WSL filesystem being mounted in Windows. So I decided to add Windows support for `deluge-backup`.

Only for me (or those who clone the repo): `just deluge-backup-win` allows me to call the Windows version of `deluge-backup` from WSL, meaning I don't have to open a Powershell terminal when I want to run this.
