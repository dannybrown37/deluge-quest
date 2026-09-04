---
layout: ../layouts/ProseLayout.astro
title: Frugally Anticipated Questions
description: About deluge.quest — open source utilities for the Synthstrom Deluge.
---

## What is deluge.quest?

deluge.quest is a love letter to the [Synthstrom Deluge](https://synthstrom.com/product/deluge/).

## ...What does that mean?

The Deluge stores songs as XML files on an SD card. These can be difficult to work with on the Deluge itself. On the flipside, there are numerous pain points to manually managing one's SD card on a computer.

This website provides a number of tools to improve the Deluge SD card management experience, to help translate between the Deluge and other music software and back, and to help enhance the creative process of making music with the Deluge.

## Who wrote the music on the site?

I did! Check out the load button on DelugeUI or the [Songs](/songs) page to see what I've made.

## Who are you?

I'm Danny, a software engineer and musician. I love the Deluge! I have owned dozens of instruments in my life, probably into the 100s now (easily so if you count effects pedals...). The Deluge has sparked the most creativity and resulted in the most output.

I have been writing scripts to help me manage my Deluge files for years. This website represents a more ambitious quest to share tools, music, and a really cool website with the Deluge community.

## Why should I trust these tools?

You are right to be skeptical! I've made great attempts to make them as safe to use as possible: soft deletions, confirmation prompts, and no server-side code.

That said! I personally always run these tools on a backup of my SD card, not on the real thing. (Or sometimes on the real thing if I have a really recent backup.) I recommend you do the same. I cannot be responsible for any data loss, so please use these tools at your own risk.

## What gets tracked here?

The site is tracking song plays and tool usage counts, basic analytics only.

No data you load onto the site is sent to a server. All of the tools run directly in the browser, so your files never leave your machine. No server, no account, no upload.

## How it works

Everything runs in your browser. The Python conversion library is compiled to WebAssembly via [Pyodide](https://pyodide.org), so your files never leave your machine. No server, no account, no upload.

## Source

The code is on GitHub. Contributions welcome — especially from the Deluge community.

## Built with

- [Astro](https://astro.build) + [Svelte](https://svelte.dev)
- [Pyodide](https://pyodide.org) (Python in WebAssembly)
- Hosted on [Vercel](https://vercel.com)
