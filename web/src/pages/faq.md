---
layout: ../layouts/ProseLayout.astro
title: Frugally Anticipated Queries
description: About deluge.quest's open source utilities for the Synthstrom Deluge.
---

## What is deluge.quest?

deluge.quest is a love letter to the [Synthstrom Deluge](https://synthstrom.com/product/deluge/).

## ...what does that *mean*?

This website represents a personal quest to compile disparate tools into an incredibly ergonomic, secure, easy-to-use interface, available on any device with a web browser.

As I built out the "Deluge" UI, I also realized that having Deluge-derived tracks to make the knobs and buttons responsive would be fun, so I compiled a number of Deluge-only tracks I've made over the years and loaded them on the site. Thus, it's also become a music distribution platform of sorts for my own Deluge tracks.

## Who are you?

I'm Danny, a self-taught professional software engineer and classically-academically trained amateur musician.

I love the Deluge! I got my still-7-seg-screen unit at the end of 2019. I have owned dozens of instruments in my life, probably into the 100s now (easily so if you count effects pedals...), and the Deluge is by far my favorite, sparking the most creativity and resulting in the most output.

I have been writing scripts to help manage my Deluge files for years. This website represents my most ambitious Deluge quest to date.

## Why did you make this site?

The website is lots of things: an easy way to use and access my tools, a fun project to hone my skills, and a way to share music made with the Deluge.

The Deluge stores songs as XML files on an SD card. These can be difficult to work with on the Deluge itself. On the flipside, there are numerous pain points to manually managing one's SD card on a computer. The difficulties lead to a mess of files on the SD card, which makes it hard to find what I need, and thus less likely to use the Deluge. This is a true bummer.

This website provides a number of tools to improve the Deluge SD card management experience, to help translate between the Deluge and other music software and back, and to help enhance the creative process of making music with the Deluge.

By creating this website, I personally am more likely to 1) make music with my Deluge, 2) create additional tools to help manage my Deluge files.

## Are these tools safe to use on my files?

You are right to be skeptical! I've made great efforts to make them as safe to use as possible: soft deletions, confirmation prompts, backups before changes, and no server-side code.

That said! I personally always run these tools on a backup of my SD card, not on the real thing. (Or sometimes on the real thing if I have a really recent backup.) I recommend you do the same. I cannot be responsible for any data loss, so please follow precautions and use these tools at your own risk.

Here's a workflow I use and enjoy:

1. Set up the [Backup](/backup) tool if you feel up to running a CLI.

2. Once you have your local backup, any time you pop up in your SD card, immediately run `deluge-backup save`.

3. Since you backed up, you can freely and safely make changes on the SD card itself at this point. If you mess something up, just restore from your local backup to your card.

4. Run `deluge-backup save` one more time. Now you have a backup of the SD card both before and after your changes. You can always revert to a previous state if you really need to.

## Is this secure?  Are you uploading my files?

Yes, it's secure!

No data you load onto the site is sent to a server. All of the tools run directly in the browser, i.e., your files never leave your machine. No server, no account, no upload.

I jokingly toyed with the idea of a "donate patches to the site author" button, but the [Card Management](/manage) tool has revealed the sheer number of unused patches and samples I already have. I can't manage even more of them! (Unless you've got really good ones, in which case, please [reach out](mailto:danny@deluge.quest) to me. I legit would appreciate some great Deluge patches.)

## What *are* you tracking?

The site is tracking song plays and tool usage counts: basic analytics to understand how people use the site.

## What is the tech stack?

- [Astro](https://astro.build) + [Svelte](https://svelte.dev)
- [Pyodide](https://pyodide.org) (Python in WebAssembly)
- Hosted on [Vercel](https://vercel.com)
- The code is on [GitHub](https://github.com/dannybrown37/deluge-quest)

## Who wrote the music on the site?

[I did](#who-are-you)! Check out the load/play buttons on the [home page's "Deluge"](/) or the [Songs](/songs) page to see what I've made.

This is a Deluge site, so all tracks here were made with sounds generated entirely from the Deluge at recording time. Other than compressing from WAV to MP3, no post-processing was done to any tracks.
