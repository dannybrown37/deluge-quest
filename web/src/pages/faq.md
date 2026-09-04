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

The website itself is also just a fun project and a way to share music made with the Deluge.

## Who wrote the music on the site?

I did! Check out the load button on the home page's "Deluge" or the [Songs](/songs) page to see what I've made.

This is a Deluge site, so all tracks here were made with sounds generated entirely from the Deluge at record time.

## Who are you?

I'm Danny, a software engineer and musician. I love the Deluge! I have owned dozens of instruments in my life, probably into the 100s now (easily so if you count effects pedals...), and the Deluge is by far my favorite, sparking the most creativity and resulting in the most output.

I have been writing scripts to help me manage my Deluge files for years. This website represents a more ambitious quest to share tools, music, and a really cool website with the Deluge community.

## Are these tools safe to use on my files?

You are right to be skeptical! I've made great attempts to make them as safe to use as possible: soft deletions, confirmation prompts, backups before changes, and no server-side code.

That said! I personally always run these tools on a backup of my SD card, not on the real thing. (Or sometimes on the real thing if I have a really recent backup.) I recommend you do the same. I cannot be responsible for any data loss, so please follow precautions and use these tools at your own risk.

## Is this secure? What are you tracking? Are you uploading my files?

Yes, it's secure!

The site is tracking song plays and tool usage counts, basic analytics to understand how people use the site.

No data you load onto the site is sent to a server. All of the tools run directly in the browser, so your files never leave your machine. No server, no account, no upload.

I jokingly toyed with the idea of a "donate patches to the site author" button, but the [Card Management](/manage) tool has revealed the sheer number of unused patches and samples I already have. I can't manage even more of them! (Unless you've got really good ones, in which case, please [reach out](mailto:danny@deluge.quest) to me.)

## What is the tech stack?

- [Astro](https://astro.build) + [Svelte](https://svelte.dev)
- [Pyodide](https://pyodide.org) (Python in WebAssembly)
- Hosted on [Vercel](https://vercel.com)
- The code is on GitHub
