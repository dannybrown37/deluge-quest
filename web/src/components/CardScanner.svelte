<script lang="ts">
  import { TRASH_DIR, getOrCreateDir, moveToTrash } from "../lib/softDelete";
  import { cardStore, walkHandle } from "../lib/cardStore";
  import { trackToolAction } from "../lib/analytics";

  type State = "idle" | "indexing" | "processing" | "done" | "error";

  interface MissingRef {
    sample: string;
    referencedBy: string[];
  }

  interface DuplicateGroup {
    hash: string;
    size: number;
    files: string[];
  }

  interface InvalidXmlFile {
    path: string;
    autoFixable: boolean;
  }

  interface CardReport {
    totalSamples: number;
    totalSamplesBytes: number;
    totalReferences: number;
    unusedSamples: string[];
    missingReferences: MissingRef[];
    unusedPresets: string[];
    reclaimableBytes: number;
    duplicates: DuplicateGroup[];
    duplicateWastedBytes: number;
    songsByType: {
      delugeOnly: string[];
      mixed: string[];
      externalOnly: string[];
    };
    invalidXml: InvalidXmlFile[];
  }

  const AUDIO_EXTENSIONS = new Set(["wav", "aif", "aiff"]);
  const XML_DIRS = ["SONGS", "KITS", "SYNTHS"];
  const FILE_ATTRS = ["fileName", "filePath"];
  const SOFT_DELETE_DIR = "SOFT_DELETE";
  const REPAIR_BACKUP_DIR = "REPAIR_BACKUP";
  const APP_MANAGED_DIRS = new Set([SOFT_DELETE_DIR, REPAIR_BACKUP_DIR]);

  /** SOFT_DELETE/ and REPAIR_BACKUP/ are app-managed, not card content — never scan, report, or count them. */
  function isAppManagedPath(relPath: string): boolean {
    return APP_MANAGED_DIRS.has(relPath.toUpperCase().split("/")[0]);
  }

  let state: State = $state("idle");
  let errorMsg = $state("");
  let report: CardReport | null = $state(null);
  let dragOver = $state(false);
  let cardName = $state("");
  let listCategory = $state<"samples" | "songs" | "analysis" | "backup">("samples");
  let progress = $state("");
  let progressPct = $state(0);
  let canWrite = $state(false);
  let rootHandle = $state<FileSystemDirectoryHandle | null>(null);
  let movedFiles = $state(new Set<string>());
  let movingFiles = $state(new Set<string>());
  let movedSongs = $state(new Map<string, string>());
  let movingSongs = $state(new Set<string>());
  let songViewMode = $state<"flat" | "folders">("flat");
  let expandedSongDirs = $state(new Set<string>());
  let fileHandles = $state(new Map<string, File>());
  let usingCardStore = $state(false);
  let reconnectAvailable = $state(false);
  let playingFile = $state<string | null>(null);
  let currentAudio = $state<HTMLAudioElement | null>(null);

  let refSources = $state(new Map<string, Set<string>>());
  let allSamplePaths = $state<string[]>([]);
  let allSampleSizes = $state(new Map<string, number>());
  let xmlTexts = $state(new Map<string, string>());
  let expandedRefs = $state(new Set<string>());

  interface BackupFileEntry {
    path: string;
    size: number;
  }
  interface BackupDiff {
    newFiles: BackupFileEntry[];
    changedFiles: BackupFileEntry[];
    unchangedCount: number;
    totalCopyBytes: number;
    onlyInBackup: string[];
  }
  let backupHandle = $state<FileSystemDirectoryHandle | null>(null);
  let backupDiff = $state<BackupDiff | null>(null);
  let backupProgress = $state("");
  let backupProgressPct = $state(0);
  let backupRunning = $state(false);
  let backupScanning = $state(false);
  let backupComplete = $state(false);
  let backupError = $state("");
  let backupCopiedCount = $state(0);
  let backupCopiedBytes = $state(0);

  let movedCount = $derived(movedFiles.size);
  let hasFileSystemAccess = $derived(typeof window !== "undefined" && "showDirectoryPicker" in window);

  function ext(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  function topDir(path: string): string {
    const i = path.indexOf("/");
    return i >= 0 ? path.slice(0, i) : path;
  }

  /**
   * Some firmware versions write duplicate attributes on the same element (observed on
   * c1.2.1, e.g. repeated isPlaying/length/colourOffset on audioTrack clips) — not
   * well-formed XML, so DOMParser rejects the whole document. Keep the last value per
   * attribute, matching how the firmware likely intended incremental writes to land.
   */
  function dedupeAttributes(xml: string): string {
    return xml.replace(/<[^!?/][^>]*>/gs, (tag) => {
      const head = tag.match(/^<\/?[\w:.-]+/)?.[0];
      if (!head) return tag;
      const selfClose = /\/\s*>$/.test(tag);
      const seen = new Map<string, string>();
      const attrRe = /([\w:.-]+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(tag)) !== null) seen.set(m[1], m[2]);
      if (seen.size === 0) return tag;
      const attrs = [...seen.entries()].map(([k, v]) => `${k}="${v}"`).join(" ");
      return `${head} ${attrs}${selfClose ? " />" : ">"}`;
    });
  }

  function parseSongXml(xmlText: string): Document {
    const parser = new DOMParser();
    let doc = parser.parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) {
      doc = parser.parseFromString(dedupeAttributes(xmlText), "text/xml");
    }
    return doc;
  }

  function normalizePath(p: string): string {
    return p.replace(/^\//, "").toUpperCase();
  }

  function extractFileRefs(xmlText: string): Set<string> {
    const refs = new Set<string>();
    const doc = parseSongXml(xmlText);
    if (doc.querySelector("parsererror")) return refs;
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      if (node instanceof Element) {
        for (const attr of FILE_ATTRS) {
          const val = node.getAttribute(attr)?.trim();
          if (val) refs.add(val);
        }
      }
      node = walker.nextNode();
    }
    return refs;
  }

  function classifyInstrumentGear(xmlText: string): "delugeOnly" | "mixed" | "externalOnly" | null {
    const doc = parseSongXml(xmlText);
    if (doc.querySelector("parsererror")) return null;
    // Tag names vary by firmware: older exports use midiChannel/cvChannel/audioOutput,
    // firmware c1.2.1+ uses midi/cv/audioTrack. Check both.
    const hasExternal = doc.querySelector("midi, midiChannel, cv, cvChannel") !== null;
    const hasInternal = doc.querySelector("sound, kit") !== null;
    if (hasInternal && hasExternal) return "mixed";
    if (hasExternal) return "externalOnly";
    // No external-gear signal at all — native to the Deluge, whether it's synths/kits,
    // audio-only clips (audioTrack/audioOutput), or an empty song.
    return "delugeOnly";
  }

  function extractPresetRefs(xmlText: string): Set<string> {
    const names = new Set<string>();
    const doc = parseSongXml(xmlText);
    if (doc.querySelector("parsererror")) return names;
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      if (node instanceof Element) {
        const pname = node.getAttribute("presetName")?.trim();
        if (pname) names.add(pname);
        const pslot = node.getAttribute("presetSlot");
        if (pslot !== null) {
          const tag = node.tagName.toLowerCase();
          if (tag === "kit" || tag === "sound") {
            const sub = node.getAttribute("presetSubSlot") ?? "";
            const folder = tag === "kit" ? "KITS" : "SYNTHS";
            names.add(`${folder}/${pslot}/${sub}`);
          }
        }
      }
      node = walker.nextNode();
    }
    return names;
  }

  async function scanFromHandle() {
    state = "indexing";
    progress = "Indexing card";
    progressPct = 0;
    await cardStore.pickDirectory((stage, done, total) => {
      progress = total > 0 ? `${stage} (${done}/${total})` : stage;
      progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
    });
    await runScanFromCardStore();
  }

  async function reconnectFromCardStore() {
    state = "indexing";
    progress = "Reconnecting";
    progressPct = 0;
    const ok = await cardStore.requestReconnect((stage, done, total) => {
      progress = total > 0 ? `${stage} (${done}/${total})` : stage;
      progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
    });
    if (ok) {
      await runScanFromCardStore();
    } else {
      state = "idle";
    }
  }

  /** Clears all move/fix tracking state — must run at the start of every fresh scan, not just
   * full reset(), or stale entries from a prior run can silently no-op legitimate actions. */
  function resetActionState() {
    movedFiles = new Set();
    movingFiles = new Set();
    movedSongs = new Map();
    movingSongs = new Set();
    fixedXmlFiles = new Set();
    fixingXmlFiles = new Set();
    xmlFixErrors = new Map();
  }

  async function runScanFromCardStore() {
    resetActionState();
    rootHandle = cardStore.rootHandle;
    canWrite = true;
    cardName = rootHandle?.name ?? "";

    if (cardStore.sampleIndex.size === 0) {
      state = "error";
      errorMsg = "Not a Deluge SD card: no SAMPLES directory found. Select the SD card root folder.";
      return;
    }

    state = "processing";
    progress = "Scanning XML references...";
    await new Promise(r => setTimeout(r, 0));

    const allSamples = new Map<string, number>();
    const sampleHandles = new Map<string, File>();
    for (const info of cardStore.sampleIndex.values()) {
      allSamples.set(info.path, info.size);
    }

    const xmlEntries: [string, string][] = [
      ...[...cardStore.songXmls.entries()],
      ...[...cardStore.presetIndex.entries()],
    ];

    const getSampleFile = async (path: string) => {
      const cached = sampleHandles.get(path);
      if (cached) return cached;
      const info = cardStore.sampleIndex.get(path.toLowerCase());
      if (!info) throw new Error(`Sample not indexed: ${path}`);
      const file = await info.handle.getFile();
      sampleHandles.set(path, file);
      return file;
    };

    await computeReport(allSamples, xmlEntries, getSampleFile);
    fileHandles = sampleHandles;
    usingCardStore = true;
  }

  async function scanCard(files: File[]) {
    canWrite = false;
    rootHandle = null;
    state = "processing";
    progress = "Indexing files...";

    await new Promise(r => setTimeout(r, 0));

    const filesByPath = new Map<string, File>();
    let rootPrefix = "";

    const firstPath = files[0] && ((files[0] as any).webkitRelativePath as string);
    if (firstPath) {
      rootPrefix = firstPath.split("/")[0] + "/";
      cardName = firstPath.split("/")[0];
    }

    for (const f of files) {
      const rel = (f as any).webkitRelativePath as string || f.name;
      if (isAppManagedPath(stripRootPrefix(rel, rootPrefix))) continue;
      filesByPath.set(rel, f);
    }

    const hasSamples = [...filesByPath.keys()].some(p => {
      const rel = stripRootPrefix(p, rootPrefix);
      return rel.toUpperCase().startsWith("SAMPLES/");
    });
    if (!hasSamples) {
      state = "error";
      errorMsg = "Not a Deluge SD card: no SAMPLES directory found. Select the SD card root folder.";
      return;
    }

    const allSamples = new Map<string, number>();
    const handles = new Map<string, File>();
    for (const [path, file] of filesByPath) {
      const rel = stripRootPrefix(path, rootPrefix);
      if (rel.toUpperCase().startsWith("SAMPLES/") && AUDIO_EXTENSIONS.has(ext(rel))) {
        allSamples.set(rel, file.size);
        handles.set(rel, file);
      }
    }
    fileHandles = handles;
    usingCardStore = false;
    resetActionState();

    progress = "Scanning XML references...";
    await new Promise(r => setTimeout(r, 0));

    const xmlEntries: [string, string][] = [];
    const xmlFilePairs: [string, File][] = [];
    for (const [path, file] of filesByPath) {
      const rel = stripRootPrefix(path, rootPrefix);
      const dir = topDir(rel).toUpperCase();
      if (XML_DIRS.includes(dir) && ext(rel) === "xml") xmlFilePairs.push([rel, file]);
    }
    let xmlDone = 0;
    for (const [rel, file] of xmlFilePairs) {
      xmlEntries.push([rel, await file.text()]);
      xmlDone++;
      if (xmlDone % 20 === 0) {
        progress = `Scanning XML references... ${xmlDone}/${xmlFilePairs.length}`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    await computeReport(allSamples, xmlEntries, async (rel) => {
      const file = handles.get(rel);
      if (!file) throw new Error(`Sample not indexed: ${rel}`);
      return file;
    });
  }

  function stripRootPrefix(p: string, rootPrefix: string): string {
    return rootPrefix && p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;
  }

  /** Shared analysis: reference scanning, missing/unused detection, preset usage, duplicate hashing. */
  async function computeReport(
    allSamples: Map<string, number>,
    xmlEntries: [string, string][],
    getSampleFile: (relPath: string) => Promise<File>,
  ) {
    const localRefSources = new Map<string, Set<string>>();
    const songsByType = { delugeOnly: [] as string[], mixed: [] as string[], externalOnly: [] as string[] };
    const invalidXml: InvalidXmlFile[] = [];
    const localXmlTexts = new Map<string, string>();

    for (const [rel, text] of xmlEntries) {
      localXmlTexts.set(rel, text);
      const wellFormed = new DOMParser().parseFromString(text, "text/xml").querySelector("parsererror") === null;
      if (!wellFormed) {
        const autoFixable = new DOMParser().parseFromString(dedupeAttributes(text), "text/xml").querySelector("parsererror") === null;
        invalidXml.push({ path: rel, autoFixable });
      }

      for (const ref of extractFileRefs(text)) {
        if (!localRefSources.has(ref)) localRefSources.set(ref, new Set());
        localRefSources.get(ref)!.add(rel);
      }
      if (topDir(rel).toUpperCase() === "SONGS") {
        const gearType = classifyInstrumentGear(text);
        if (gearType) songsByType[gearType].push(rel);
      }
    }
    invalidXml.sort((a, b) => a.path.localeCompare(b.path));

    const sampleRefs = new Map<string, Set<string>>();
    for (const [ref, sources] of localRefSources) {
      if (normalizePath(ref).startsWith("SAMPLES/")) sampleRefs.set(ref, sources);
    }
    const normToSample = new Map<string, string>();
    for (const k of allSamples.keys()) normToSample.set(normalizePath(k), k);
    const normRefs = new Set([...sampleRefs.keys()].map(normalizePath));
    const unused = [...normToSample.entries()]
      .filter(([norm]) => !normRefs.has(norm))
      .map(([, orig]) => orig)
      .sort();
    const normKeys = new Set(normToSample.keys());
    const missing: MissingRef[] = [...sampleRefs.entries()]
      .filter(([r]) => !normKeys.has(normalizePath(r)))
      .map(([r, sources]) => ({ sample: r, referencedBy: [...sources].sort() }))
      .sort((a, b) => a.sample.localeCompare(b.sample));
    const totalBytes = [...allSamples.values()].reduce((a, b) => a + b, 0);
    const reclaimable = unused.reduce((sum, k) => sum + (allSamples.get(k) ?? 0), 0);

    progress = "Checking presets...";
    await new Promise(r => setTimeout(r, 0));

    const presetNames = new Set<string>();
    for (const [rel, text] of xmlEntries) {
      if (topDir(rel).toUpperCase() === "SONGS") {
        for (const name of extractPresetRefs(text)) {
          presetNames.add(name);
        }
      }
    }

    const unusedPresets: string[] = [];
    for (const [rel] of xmlEntries) {
      const dir = topDir(rel).toUpperCase();
      if (dir === "KITS" || dir === "SYNTHS") {
        const basename = rel.split("/").pop() ?? "";
        const stem = basename.replace(/\.xml$/i, "");
        const isUsed = [...presetNames].some(n => n === stem || n.includes(stem));
        if (!isUsed) {
          unusedPresets.push(rel);
        }
      }
    }
    unusedPresets.sort();

    progress = "Finding duplicates (grouping by size)...";
    await new Promise(r => setTimeout(r, 0));

    const sizeGroups = new Map<number, string[]>();
    for (const [path, size] of allSamples) {
      const group = sizeGroups.get(size);
      if (group) group.push(path);
      else sizeGroups.set(size, [path]);
    }

    const candidatePaths: string[] = [];
    for (const [size, paths] of sizeGroups) {
      if (paths.length < 2 || size === 0) continue;
      candidatePaths.push(...paths);
    }

    const hashGroups = new Map<string, { size: number; files: string[] }>();
    let hashDone = 0;
    const totalToHash = candidatePaths.length;

    for (const path of candidatePaths) {
      const file = await getSampleFile(path);
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const hashArr = new Uint8Array(hashBuf);
      const hash = Array.from(hashArr, b => b.toString(16).padStart(2, "0")).join("");

      const existing = hashGroups.get(hash);
      if (existing) {
        existing.files.push(path);
      } else {
        hashGroups.set(hash, { size: file.size, files: [path] });
      }

      hashDone++;
      if (hashDone % 50 === 0) {
        progress = `Finding duplicates (hashing ${hashDone}/${totalToHash})...`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const duplicates: DuplicateGroup[] = [];
    let duplicateWastedBytes = 0;
    for (const [hash, { size, files }] of hashGroups) {
      if (files.length < 2) continue;
      files.sort();
      duplicates.push({ hash, size, files });
      duplicateWastedBytes += size * (files.length - 1);
    }
    duplicates.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));

    songsByType.delugeOnly.sort();
    songsByType.mixed.sort();
    songsByType.externalOnly.sort();

    refSources = localRefSources;
    allSamplePaths = [...allSamples.keys()].sort();
    allSampleSizes = allSamples;
    xmlTexts = localXmlTexts;

    report = {
      totalSamples: allSamples.size,
      totalSamplesBytes: totalBytes,
      totalReferences: sampleRefs.size,
      unusedSamples: unused,
      missingReferences: missing,
      unusedPresets,
      reclaimableBytes: reclaimable,
      duplicates,
      duplicateWastedBytes,
      songsByType,
      invalidXml,
    };
    state = "done";
    saveToSession();
    trackToolAction("manage", "scan", { samples: report.totalSamples, unused: report.unusedSamples.length });
  }

  async function moveSample(samplePath: string) {
    if (!rootHandle || movedFiles.has(samplePath) || movingFiles.has(samplePath)) return;

    const next = new Set(movingFiles);
    next.add(samplePath);
    movingFiles = next;

    try {
      await moveToTrash(rootHandle, samplePath);

      const moved = new Set(movedFiles);
      moved.add(samplePath);
      movedFiles = moved;
      trackToolAction("manage", "delete_sample");
    } catch (e: any) {
      console.error(`Failed to move ${samplePath}:`, e);
    } finally {
      const rm = new Set(movingFiles);
      rm.delete(samplePath);
      movingFiles = rm;
    }
  }

  const SONG_CATEGORY_DIRS = ["DELUGE_ONLY", "EXTERNAL_GEAR"];

  /** Removes dirPath and any now-empty ancestors, stopping at (not including) stopAt. */
  async function removeEmptyDirsUpTo(root: FileSystemDirectoryHandle, dirPath: string, stopAt: string) {
    let path = dirPath;
    while (path && path !== stopAt) {
      const parts = path.split("/");
      const name = parts.pop()!;
      const parentPath = parts.join("/");
      const parentHandle = parentPath ? await getOrCreateDir(root, parentPath) : root;

      const dirHandle: any = await parentHandle.getDirectoryHandle(name, { create: true });
      let isEmpty = true;
      for await (const _ of dirHandle.values()) {
        isEmpty = false;
        break;
      }
      if (!isEmpty) return;

      await parentHandle.removeEntry(name);
      path = parentPath;
    }
  }

  async function moveSongToCategory(songPath: string, category: "DELUGE_ONLY" | "EXTERNAL_GEAR") {
    if (!rootHandle || movedSongs.has(songPath) || movingSongs.has(songPath)) return;

    const next = new Set(movingSongs);
    next.add(songPath);
    movingSongs = next;

    try {
      const parts = songPath.split("/");
      parts.shift(); // drop leading "SONGS"
      if (SONG_CATEGORY_DIRS.includes(parts[0])) parts.shift();
      const fileName = parts.pop()!;
      const relDir = parts.join("/");

      const sourceParts = songPath.split("/");
      const sourceFileName = sourceParts.pop()!;
      const sourceDir = sourceParts.join("/");
      const destDirPath = ["SONGS", category, relDir].filter(Boolean).join("/");

      if (sourceDir === destDirPath && sourceFileName === fileName) {
        const moved = new Map(movedSongs);
        moved.set(songPath, "already sorted");
        movedSongs = moved;
        return;
      }

      const sourceDirHandle = await getOrCreateDir(rootHandle, sourceDir);
      const sourceFileHandle = await sourceDirHandle.getFileHandle(sourceFileName);
      const file = await sourceFileHandle.getFile();
      const data = await file.arrayBuffer();

      const destDirHandle = await getOrCreateDir(rootHandle, destDirPath);
      const destFileHandle = await destDirHandle.getFileHandle(fileName, { create: true });
      const writable = await destFileHandle.createWritable();
      await writable.write(data);
      await writable.close();

      await sourceDirHandle.removeEntry(sourceFileName);
      await removeEmptyDirsUpTo(rootHandle, sourceDir, "SONGS");

      const destPath = [destDirPath, fileName].join("/");
      const moved = new Map(movedSongs);
      moved.set(songPath, `→ ${destPath}`);
      movedSongs = moved;
    } catch (e: any) {
      console.error(`Failed to move ${songPath}:`, e);
    } finally {
      const rm = new Set(movingSongs);
      rm.delete(songPath);
      movingSongs = rm;
    }
  }

  async function sortAllSongs() {
    if (!rootHandle || !report) return;
    const all = [
      ...report.songsByType.delugeOnly.map(s => ({ path: s, category: "DELUGE_ONLY" as const })),
      ...report.songsByType.mixed.map(s => ({ path: s, category: "EXTERNAL_GEAR" as const })),
      ...report.songsByType.externalOnly.map(s => ({ path: s, category: "EXTERNAL_GEAR" as const })),
    ];
    for (const { path, category } of all) {
      if (!movedSongs.has(path)) await moveSongToCategory(path, category);
    }
    trackToolAction("manage", "sort_songs", { songs: all.length });
  }


  function toggleRefExpand(path: string) {
    const next = new Set(expandedRefs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedRefs = next;
  }

  let fixedXmlFiles = $state(new Set<string>());
  let fixingXmlFiles = $state(new Set<string>());
  let xmlFixErrors = $state(new Map<string, string>());
  async function fixXmlFile(path: string) {
    if (!rootHandle || fixedXmlFiles.has(path) || fixingXmlFiles.has(path)) return;

    const next = new Set(fixingXmlFiles);
    next.add(path);
    fixingXmlFiles = next;

    try {
      const parts = path.split("/");
      const fileName = parts.pop()!;
      const dirPath = parts.join("/");

      const dirHandle = await getOrCreateDir(rootHandle, dirPath);
      const fileHandle = await dirHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const rawText = await file.text();

      const fixedText = dedupeAttributes(rawText);
      const stillBroken = new DOMParser().parseFromString(fixedText, "text/xml").querySelector("parsererror") !== null;
      if (stillBroken) {
        throw new Error("Automatic fix did not produce valid XML — needs manual review");
      }

      const backupDirHandle = await getOrCreateDir(rootHandle, `${REPAIR_BACKUP_DIR}/${dirPath}`);
      const backupFileHandle = await backupDirHandle.getFileHandle(fileName, { create: true });
      const backupWritable = await backupFileHandle.createWritable();
      await backupWritable.write(rawText);
      await backupWritable.close();

      const destWritable = await (await dirHandle.getFileHandle(fileName, { create: true })).createWritable();
      await destWritable.write(fixedText);
      await destWritable.close();

      const fixed = new Set(fixedXmlFiles);
      fixed.add(path);
      fixedXmlFiles = fixed;
      const errs = new Map(xmlFixErrors);
      errs.delete(path);
      xmlFixErrors = errs;
    } catch (e: any) {
      console.error(`Failed to fix ${path}:`, e);
      const errs = new Map(xmlFixErrors);
      errs.set(path, e.message || "Fix failed");
      xmlFixErrors = errs;
    } finally {
      const rm = new Set(fixingXmlFiles);
      rm.delete(path);
      fixingXmlFiles = rm;
    }
  }

  async function fixAllXml() {
    if (!rootHandle || !report) return;
    for (const { path, autoFixable } of report.invalidXml) {
      if (autoFixable && !fixedXmlFiles.has(path)) await fixXmlFile(path);
    }
    trackToolAction("manage", "fix_all_xml");
  }

  function allCardFiles(): { path: string; size: number; lastModified: number }[] {
    const files: { path: string; size: number; lastModified: number }[] = [];
    for (const [path, xml] of cardStore.songXmls) {
      const mod = cardStore.songLastModified.get(path) ?? 0;
      files.push({ path, size: new Blob([xml]).size, lastModified: mod });
    }
    for (const [path, xml] of cardStore.presetIndex) {
      files.push({ path, size: new Blob([xml]).size, lastModified: 0 });
    }
    for (const info of cardStore.sampleIndex.values()) {
      files.push({ path: info.path, size: info.size, lastModified: 0 });
    }
    return files;
  }

  async function pickBackupDestination() {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      backupHandle = handle;
      backupDiff = null;
      backupComplete = false;
      backupError = "";
      await computeBackupDiff();
    } catch (e: any) {
      if (e.name !== "AbortError") {
        backupError = e.message || "Failed to open backup folder";
      }
    }
  }

  async function computeBackupDiff() {
    if (!backupHandle) return;
    backupScanning = true;
    backupError = "";
    backupProgress = "Scanning backup folder...";
    backupProgressPct = 0;
    await new Promise(r => setTimeout(r, 0));

    try {
      const destEntries: { path: string; handle: FileSystemFileHandle }[] = [];
      await walkHandle(backupHandle, "", destEntries);

      const destFiles = new Map<string, { size: number; lastModified: number }>();
      let scanned = 0;
      for (const entry of destEntries) {
        const file = await entry.handle.getFile();
        destFiles.set(entry.path.toLowerCase(), { size: file.size, lastModified: file.lastModified });
        scanned++;
        if (scanned % 25 === 0) {
          backupProgress = `Scanning backup (${scanned}/${destEntries.length})`;
          backupProgressPct = Math.round((scanned / destEntries.length) * 100);
          await new Promise(r => setTimeout(r, 0));
        }
      }

      const cardFiles = allCardFiles();
      const newFiles: BackupFileEntry[] = [];
      const changedFiles: BackupFileEntry[] = [];
      let unchangedCount = 0;
      const seenDest = new Set<string>();

      for (const cf of cardFiles) {
        const key = cf.path.toLowerCase();
        seenDest.add(key);
        const dest = destFiles.get(key);
        if (!dest) {
          newFiles.push({ path: cf.path, size: cf.size });
        } else if (cf.size > 0 && cf.size !== dest.size) {
          changedFiles.push({ path: cf.path, size: cf.size });
        } else if (cf.lastModified > 0 && cf.lastModified !== dest.lastModified) {
          changedFiles.push({ path: cf.path, size: cf.size });
        } else {
          unchangedCount++;
        }
      }

      const onlyInBackup: string[] = [];
      for (const [key] of destFiles) {
        if (!seenDest.has(key)) {
          const entry = destEntries.find(e => e.path.toLowerCase() === key);
          if (entry) onlyInBackup.push(entry.path);
        }
      }

      const totalCopyBytes = [...newFiles, ...changedFiles].reduce((s, f) => s + f.size, 0);

      backupDiff = { newFiles, changedFiles, unchangedCount, totalCopyBytes, onlyInBackup };
      backupProgress = "";
    } catch (e: any) {
      backupError = e.message || "Failed to scan backup folder";
    } finally {
      backupScanning = false;
    }
  }

  async function runBackup() {
    if (!backupHandle || !backupDiff || !rootHandle) return;
    backupRunning = true;
    backupComplete = false;
    backupError = "";
    backupCopiedCount = 0;
    backupCopiedBytes = 0;

    const filesToCopy = [...backupDiff.newFiles, ...backupDiff.changedFiles];
    const total = filesToCopy.length;

    try {
      for (let i = 0; i < filesToCopy.length; i++) {
        const { path: filePath } = filesToCopy[i];
        backupProgress = `Copying ${i + 1}/${total}: ${filePath.split("/").pop()}`;
        backupProgressPct = Math.round(((i + 1) / total) * 100);

        const parts = filePath.split("/");
        const fileName = parts.pop()!;
        const dirPath = parts.join("/");

        const srcDirHandle = await getOrCreateDir(rootHandle, dirPath);
        const srcFileHandle = await srcDirHandle.getFileHandle(fileName);
        const file = await srcFileHandle.getFile();
        const data = await file.arrayBuffer();

        const destDirHandle = await getOrCreateDir(backupHandle, dirPath);
        const destFileHandle = await destDirHandle.getFileHandle(fileName, { create: true });
        const writable = await destFileHandle.createWritable();
        await writable.write(data);
        await writable.close();

        backupCopiedCount = i + 1;
        backupCopiedBytes += data.byteLength;

        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }

      backupComplete = true;
      backupProgress = "";
      trackToolAction("manage", "backup", { files: total });
    } catch (e: any) {
      backupError = e.message || "Backup failed";
    } finally {
      backupRunning = false;
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function openDirectoryPicker() {
    try {
      await scanFromHandle();
    } catch (e: any) {
      if (e.name !== "AbortError") {
        state = "error";
        errorMsg = e.message || "Failed to open directory";
      }
    }
  }

  function handleInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files?.length) scanCard(Array.from(files));
  }

  async function readEntryRecursive(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve([f]),
          () => resolve([]),
        );
      });
    }
    if (entry.isDirectory) {
      if (APP_MANAGED_DIRS.has(entry.name.toUpperCase())) return [];
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        const all: FileSystemEntry[] = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (batch.length === 0) { resolve(all); return; }
            all.push(...batch);
            readBatch();
          }, () => resolve(all));
        };
        readBatch();
      });
      const nested = await Promise.all(entries.map(readEntryRecursive));
      return nested.flat();
    }
    return [];
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const items = e.dataTransfer?.items;
    if (items) {
      const entries = Array.from(items)
        .map(item => item.webkitGetAsEntry?.())
        .filter((e): e is FileSystemEntry => e != null);
      if (entries.length > 0) {
        const allFiles = (await Promise.all(entries.map(readEntryRecursive))).flat();
        await scanCard(allFiles);
        return;
      }
    }
    const files = e.dataTransfer?.files;
    if (files?.length) await scanCard(Array.from(files));
  }

  function exportJson() {
    if (!report) return;
    trackToolAction("manage", "export_json");
    const data = {
      total_samples: report.totalSamples,
      total_samples_bytes: report.totalSamplesBytes,
      total_references: report.totalReferences,
      unused_samples: report.unusedSamples,
      missing_references: report.missingReferences.map(m => ({ sample: m.sample, referenced_by: m.referencedBy })),
      unused_presets: report.unusedPresets,
      reclaimable_bytes: report.reclaimableBytes,
      duplicates: (report.duplicates ?? []).map(d => ({ hash: d.hash, size: d.size, files: d.files })),
      duplicate_wasted_bytes: report.duplicateWastedBytes ?? 0,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deluge-clean-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const CACHE_KEY = "deluge-clean-report";
  const CACHE_KEY_NAME = "deluge-clean-name";

  function saveToSession() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(report));
      sessionStorage.setItem(CACHE_KEY_NAME, cardName);
    } catch {}
  }

  function restoreFromSession(): boolean {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached) return false;
      cached.duplicates ??= [];
      cached.duplicateWastedBytes ??= 0;
      cached.songsByType ??= { delugeOnly: [], mixed: [], externalOnly: [] };
      cached.invalidXml ??= [];
      report = cached;
      cardName = sessionStorage.getItem(CACHE_KEY_NAME) ?? "";
      state = "done";
      return true;
    } catch {
      return false;
    }
  }

  async function tryReconnect() {
    const hadCache = restoreFromSession();
    try {
      if (await cardStore.reconnect()) {
        rootHandle = cardStore.rootHandle;
        canWrite = true;
        usingCardStore = true;
        cardName = rootHandle?.name ?? cardName;
        if (!hadCache) await runScanFromCardStore();
      } else if (await cardStore.hasPersistedHandle()) {
        reconnectAvailable = true;
      }
    } catch {}
  }

  tryReconnect();

  function reset() {
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      currentAudio = null;
      playingFile = null;
    }
    state = "idle";
    report = null;
    errorMsg = "";
    cardName = "";
    fileHandles = new Map();
    rootHandle = null;
    canWrite = false;
    usingCardStore = false;
    reconnectAvailable = false;
    resetActionState();
    try {
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.removeItem(CACHE_KEY_NAME);
    } catch {}
  }

  let unusedSet = $derived(new Set(report?.unusedSamples ?? []));

  let filteredDelugeOnlySongs = $derived(
    [...(report?.songsByType.delugeOnly ?? [])].sort()
  );
  let filteredExternalSongs = $derived(
    [...(report?.songsByType.mixed ?? []), ...(report?.songsByType.externalOnly ?? [])].sort()
  );

  interface SampleFile {
    name: string;
    path: string;
    refs: string[];
    isUnused: boolean;
    size: number;
  }

  interface SampleFolderNode {
    name: string;
    files: SampleFile[];
    children: Map<string, SampleFolderNode>;
    totalFiles: number;
    folderPath: string;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function buildSampleTree(paths: string[], refs: Map<string, Set<string>>, unused: Set<string>, extraFolders: Set<string> = new Set(), sizes: Map<string, number> = new Map()): SampleFolderNode {
    const root: SampleFolderNode = { name: "", files: [], children: new Map(), totalFiles: paths.length, folderPath: "" };
    for (const p of paths) {
      const parts = p.split("/");
      const fileName = parts.pop()!;
      let node = root;
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, files: [], children: new Map(), totalFiles: 0, folderPath: currentPath });
        }
        node = node.children.get(part)!;
      }
      const fileRefs = refs.get(p);
      node.files.push({
        name: fileName,
        path: p,
        refs: fileRefs ? [...fileRefs].sort() : [],
        isUnused: unused.has(p),
        size: sizes.get(p) ?? 0,
      });
    }
    for (const folderPath of extraFolders) {
      const parts = folderPath.split("/");
      let node = root;
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, files: [], children: new Map(), totalFiles: 0, folderPath: currentPath });
        }
        node = node.children.get(part)!;
      }
    }
    function computeTotals(node: SampleFolderNode): number {
      let total = node.files.length;
      for (const child of node.children.values()) {
        total += computeTotals(child);
      }
      node.totalFiles = total;
      return total;
    }
    computeTotals(root);
    return root;
  }

  interface FolderNode {
    name: string;
    files: string[];
    children: Map<string, FolderNode>;
    totalFiles: number;
  }

  function buildTree(paths: string[]): FolderNode {
    const root: FolderNode = { name: "", files: [], children: new Map(), totalFiles: paths.length };
    for (const p of paths) {
      const parts = p.split("/");
      const fileName = parts.pop()!;
      let node = root;
      for (const part of parts) {
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, files: [], children: new Map(), totalFiles: 0 });
        }
        node = node.children.get(part)!;
      }
      node.files.push(fileName);
    }
    function computeTotals(node: FolderNode): number {
      let total = node.files.length;
      for (const child of node.children.values()) {
        total += computeTotals(child);
      }
      node.totalFiles = total;
      return total;
    }
    computeTotals(root);
    return root;
  }

  let currentBreadcrumb = $state("");

  function collectAllFolderPaths(node: SampleFolderNode): string[] {
    const paths: string[] = [];
    for (const child of node.children.values()) {
      if (child.folderPath) paths.push(child.folderPath);
      paths.push(...collectAllFolderPaths(child));
    }
    return paths;
  }

  let sampleSearch: string = $state("");
  let sampleFilter: "all" | "referenced" | "unused" = $state("all");

  let filteredSamplePaths = $derived.by(() => {
    let paths = allSamplePaths;
    if (sampleFilter === "unused") paths = paths.filter(p => unusedSet.has(p));
    else if (sampleFilter === "referenced") paths = paths.filter(p => !unusedSet.has(p));
    if (sampleSearch.trim()) {
      const q = sampleSearch.trim().toLowerCase();
      paths = paths.filter(p => p.toLowerCase().includes(q));
    }
    return paths;
  });

  let sampleTree = $derived(buildSampleTree(filteredSamplePaths, refSources, unusedSet, new Set(), allSampleSizes));
  let presetsTree = $derived(buildTree(report?.unusedPresets ?? []));

  let expandedDirs = $state(new Set<string>());

  function collectFolderPaths(node: SampleFolderNode): string[] {
    const paths: string[] = [];
    for (const child of node.children.values()) {
      if (child.folderPath) paths.push(child.folderPath);
      paths.push(...collectFolderPaths(child));
    }
    return paths;
  }

  $effect(() => {
    if (sampleSearch.trim() && filteredSamplePaths.length > 0 && filteredSamplePaths.length <= 500) {
      const allFolders = collectFolderPaths(sampleTree);
      const next = new Set([...expandedDirs, ...allFolders]);
      if (next.size !== expandedDirs.size) expandedDirs = next;
    }
  });

  function toggleDir(path: string) {
    const next = new Set(expandedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedDirs = next;
  }

  function toggleSongDir(path: string) {
    const next = new Set(expandedSongDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedSongDirs = next;
  }

  let allSongPaths = $derived([...filteredDelugeOnlySongs, ...filteredExternalSongs]);
  let songTree = $derived(buildTree(allSongPaths));

  async function playSample(samplePath: string) {
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      if (playingFile === samplePath) {
        currentAudio = null;
        playingFile = null;
        return;
      }
    }
    let file = fileHandles.get(samplePath);
    if (!file && usingCardStore) {
      const info = cardStore.sampleIndex.get(samplePath.toLowerCase());
      file = await info?.handle.getFile();
      if (file) fileHandles.set(samplePath, file);
    }
    if (!file) return;
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playingFile = null;
      currentAudio = null;
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playingFile = null;
      currentAudio = null;
    };
    audio.play();
    currentAudio = audio;
    playingFile = samplePath;
  }
</script>

{#if state === "idle"}
  <div
    class="dropzone"
    class:dropzone--over={dragOver}
    role="button"
    tabindex="0"
    ondrop={handleDrop}
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => { dragOver = false; }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (hasFileSystemAccess) openDirectoryPicker(); else document.getElementById('clean-folder-input')?.click(); }}}
  >
    <div class="dropzone-content">
      <span class="dropzone-icon">#</span>
      <p class="dropzone-title">Select your SD card folder</p>
      <p class="dropzone-sub">
        {#if hasFileSystemAccess}
          <button class="dropzone-browse" onclick={openDirectoryPicker}>Browse for folder</button>
        {:else}
          <label class="dropzone-browse">Browse for folder<input id="clean-folder-input" type="file" webkitdirectory onchange={handleInputChange} hidden /></label>
        {/if}
        or drag &amp; drop
      </p>
      <p class="dropzone-hint">
        Scans SONGS/, KITS/, SYNTHS/, and SAMPLES/ directories
        {#if !hasFileSystemAccess}
          <br/><span class="dropzone-hint-warn">Use Chrome or Edge to enable sample playback and cleanup</span>
        {/if}
      </p>
      {#if reconnectAvailable}
        <p class="dropzone-hint">
          <button type="button" class="dropzone-browse" onclick={(e) => { e.stopPropagation(); reconnectFromCardStore(); }}>
            Reconnect previously loaded SD card
          </button>
        </p>
      {/if}
      <p class="dropzone-hint">
        Don't have a card yet?
        <a href="https://synthstrom.com/product/deluge/#downloads" target="_blank" rel="noopener">Download the official factory card</a> from Synthstrom,
        unzip it, then browse to the extracted folder.
      </p>
    </div>
  </div>

{:else if state === "indexing"}
  <div class="status-card">
    <div class="status-msg">{progress}</div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progressPct}%"></div>
    </div>
  </div>

{:else if state === "processing"}
  <div class="status-card">
    <div class="status-msg">{progress}</div>
    <div class="progress-bar">
      <div class="progress-fill progress-fill--indeterminate"></div>
    </div>
  </div>

{:else if state === "done" && report}
  <div class="results">
    <div class="summary-card">
      <h2 class="summary-title">{cardName || "Deluge SD Card"}</h2>
      <div class="summary-divider"></div>

      <div class="summary-grid">
        <div class="stat">
          <span class="stat-value">{report.totalSamples.toLocaleString()}</span>
          <span class="stat-label">samples ({formatBytes(report.totalSamplesBytes)})</span>
        </div>
        <div class="stat">
          <span class="stat-value">{report.totalReferences.toLocaleString()}</span>
          <span class="stat-label">referenced</span>
        </div>
        {#if report.unusedSamples.length > 0}
          <button class="stat stat--warn stat--clickable" onclick={() => { listCategory = "analysis"; }}>
            <span class="stat-value">{report.unusedSamples.length.toLocaleString()}</span>
            <span class="stat-label">unused</span>
          </button>
        {/if}
        {#if report.missingReferences.length > 0}
          <button class="stat stat--error stat--clickable" onclick={() => { listCategory = "samples"; if (!expandedDirs.has("__broken_refs__")) toggleDir("__broken_refs__"); }}>
            <span class="stat-value">{report.missingReferences.length.toLocaleString()}</span>
            <span class="stat-label">broken refs</span>
          </button>
        {/if}
      </div>

    </div>

    <div class="actions">
      <button class="btn btn-secondary btn-sm" onclick={exportJson}>Export JSON</button>
      <button class="btn btn-secondary btn-sm" onclick={reset}>Scan another</button>
    </div>

    <div class="list-section">
      <div class="list-tabs">
        {#each [
          { id: "samples", label: `Sample Library (${report.totalSamples})` },
          { id: "songs", label: `Songs (${filteredDelugeOnlySongs.length + filteredExternalSongs.length})` },
          { id: "analysis", label: "Analysis" },
          { id: "backup", label: "Backup" },
        ] as tab}
          <button
            class="list-tab"
            class:list-tab--active={listCategory === tab.id}
            onclick={() => { listCategory = tab.id as any; }}
          >{tab.label}</button>
        {/each}
      </div>

      {#if listCategory === "samples"}
        <div class="list-group">
          {#if !canWrite}
            <p class="list-subtext">Use Chrome or Edge with "Browse for folder" to enable drag-and-drop sample moves.</p>
          {/if}

          <div class="sample-toolbar">
            <input
              class="sample-search"
              type="text"
              placeholder="Search samples..."
              bind:value={sampleSearch}
            />
            <div class="sample-filter-btns">
              {#each [["all", "All"], ["referenced", "Referenced"], ["unused", "Unused"]] as [val, label]}
                <button
                  class="btn btn-sm"
                  class:btn-secondary={sampleFilter !== val}
                  class:btn-primary={sampleFilter === val}
                  onclick={() => { sampleFilter = val as any; }}
                >{label}</button>
              {/each}
            </div>
            <button
              class="btn btn-sm btn-secondary"
              onclick={() => {
                const allFolders = collectFolderPaths(sampleTree);
                const allExpanded = allFolders.every(f => expandedDirs.has(f));
                if (allExpanded) {
                  const next = new Set(expandedDirs);
                  allFolders.forEach(f => next.delete(f));
                  expandedDirs = next;
                } else {
                  expandedDirs = new Set([...expandedDirs, ...allFolders]);
                }
              }}
            >{collectFolderPaths(sampleTree).every(f => expandedDirs.has(f)) ? "Collapse" : "Expand"}</button>
            <span class="sample-count">{filteredSamplePaths.length} / {allSamplePaths.length}</span>
          </div>

          <div class="file-tree" onscroll={(e) => {
            const container = e.currentTarget as HTMLElement;
            const folders = container.querySelectorAll('[data-folder-path]');
            let best = '';
            for (const el of folders) {
              const rect = (el as HTMLElement).getBoundingClientRect();
              const containerRect = container.getBoundingClientRect();
              if (rect.top <= containerRect.top + 40) {
                best = (el as HTMLElement).dataset.folderPath ?? '';
              }
            }
            currentBreadcrumb = best;
          }}>
            {#if currentBreadcrumb}
              <div class="breadcrumb-bar">{currentBreadcrumb}</div>
            {/if}
            {#snippet sampleFolderChildren(node: SampleFolderNode)}
              {#each [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0])) as [name, child]}
                {@const isOpen = expandedDirs.has(child.folderPath)}
                <div
                  class="tree-item"
                  data-folder-path={child.folderPath}
                >
                  <div class="tree-dir-row">
                    <button
                      class="tree-dir"
                      onclick={() => toggleDir(child.folderPath)}
                    >
                      <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                      <span class="tree-dir-name">{name}/</span>
                      <span class="tree-count">{child.totalFiles}</span>
                    </button>
                  </div>
                  {#if isOpen}
                    <div class="tree-children">
                      {@render sampleFolderChildren(child)}
                      {#each child.files.sort((a, b) => a.name.localeCompare(b.name)) as file}
                        {@const refsExpanded = expandedRefs.has(file.path)}
                        <div class="tree-file tree-file--sample">
                          <button
                            class="play-btn"
                            class:play-btn--active={playingFile === file.path}
                            onclick={() => playSample(file.path)}
                            title={playingFile === file.path ? "Stop" : "Play"}
                          >{playingFile === file.path ? "◼" : "▶"}</button>
                          <span class="tree-file-name">{file.name}</span>
                          {#if file.size > 0}
                            <span class="tree-file-size">{formatSize(file.size)}</span>
                          {/if}
                          {#if file.isUnused}
                            <span class="tree-file-badge tree-file-badge--warn">unused</span>
                          {:else if file.refs.length > 0}
                            <button
                              class="ref-count-btn"
                              onclick={() => toggleRefExpand(file.path)}
                              title="Show referencing songs/kits"
                            >{file.refs.length} ref{file.refs.length === 1 ? "" : "s"}</button>
                          {/if}
                        </div>
                        {#if refsExpanded && file.refs.length > 0}
                          <div class="ref-list">
                            {#each file.refs as ref}
                              <div class="ref-item" title={ref}>{ref.split("/").pop()}</div>
                            {/each}
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            {/snippet}
            {@render sampleFolderChildren(sampleTree)}
          </div>
        </div>

      {:else if listCategory === "songs"}
        <div class="list-group">
          <div class="songs-header">
            <h4 class="list-heading">Organize songs</h4>
            <div class="songs-header-actions">
              <button
                class="btn btn-secondary btn-sm"
                onclick={() => { songViewMode = songViewMode === "flat" ? "folders" : "flat"; }}
              >{songViewMode === "flat" ? "Show folders" : "Show flat"}</button>
              {#if canWrite}
                <button class="btn btn-secondary btn-sm" onclick={sortAllSongs}>Sort all songs</button>
              {/if}
            </div>
          </div>

          {#if songViewMode === "folders"}
            {#snippet songFolderChildren(node: FolderNode, path: string)}
              {#each [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0])) as [name, child]}
                {@const fullPath = path ? `${path}/${name}` : name}
                {@const isOpen = expandedSongDirs.has(fullPath)}
                <div class="tree-item">
                  <button class="tree-dir" onclick={() => toggleSongDir(fullPath)}>
                    <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                    <span class="tree-dir-name">{name}/</span>
                    <span class="tree-count">{child.totalFiles}</span>
                  </button>
                  {#if isOpen}
                    <div class="tree-children">
                      {@render songFolderChildren(child, fullPath)}
                      {#each child.files.sort() as file}
                        {@const filePath = fullPath ? `${fullPath}/${file}` : file}
                        {@const moveResult = movedSongs.get(filePath)}
                        {@const isMoving = movingSongs.has(filePath)}
                        <div class="tree-file tree-file--sample" class:tree-file--moved={!!moveResult}>
                          <span class="tree-file-name" title={filePath}>{file.replace(/\.XML$/i, "")}</span>
                          {#if moveResult}
                            <span class="tree-file-badge">{moveResult}</span>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            {/snippet}
            <div class="file-tree">
              {#if allSongPaths.length > 0}
                {@render songFolderChildren(songTree, "")}
              {:else}
                <p class="list-empty">No songs found.</p>
              {/if}
            </div>
          {:else}
            {#if filteredDelugeOnlySongs.length > 0}
              <h5 class="list-subheading">Deluge-only ({filteredDelugeOnlySongs.length})</h5>
              <div class="file-tree">
                {#each filteredDelugeOnlySongs as song}
                  {@const moveResult = movedSongs.get(song)}
                  {@const isMoving = movingSongs.has(song)}
                  <div class="tree-file tree-file--sample" class:tree-file--moved={!!moveResult}>
                    <span class="tree-file-name" title={song}>{song.split("/").pop()?.replace(/\.XML$/i, "") ?? song}</span>
                    {#if moveResult}
                      <span class="tree-file-badge">{moveResult}</span>
                    {:else if canWrite}
                      <button
                        class="btn btn-secondary btn-sm"
                        onclick={() => moveSongToCategory(song, "DELUGE_ONLY")}
                        disabled={isMoving}
                      >{isMoving ? "..." : "Move"}</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if filteredExternalSongs.length > 0}
              <h5 class="list-subheading">External gear ({filteredExternalSongs.length})</h5>
              <div class="file-tree">
                {#each filteredExternalSongs as song}
                  {@const moveResult = movedSongs.get(song)}
                  {@const isMoving = movingSongs.has(song)}
                  <div class="tree-file tree-file--sample" class:tree-file--moved={!!moveResult}>
                    <span class="tree-file-name" title={song}>{song.split("/").pop()?.replace(/\.XML$/i, "") ?? song}</span>
                    {#if moveResult}
                      <span class="tree-file-badge">{moveResult}</span>
                    {:else if canWrite}
                      <button
                        class="btn btn-secondary btn-sm"
                        onclick={() => moveSongToCategory(song, "EXTERNAL_GEAR")}
                        disabled={isMoving}
                      >{isMoving ? "..." : "Move"}</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if filteredDelugeOnlySongs.length === 0 && filteredExternalSongs.length === 0}
              <p class="list-empty">No songs found.</p>
            {/if}
          {/if}
        </div>

      {:else if listCategory === "analysis"}
        <div class="list-group">
          {#if report.unusedSamples.length > 0}
            <div class="analysis-section">
              <div class="songs-header">
                <h4 class="list-heading">Unused samples ({report.unusedSamples.length})</h4>
                <span class="stat-label">{formatBytes(report.reclaimableBytes)} reclaimable</span>
              </div>
              <div class="file-tree">
                {#snippet unusedFolderChildren(node: FolderNode, path: string)}
                  {#each [...node.children.entries()].sort((a, b) => b[1].totalFiles - a[1].totalFiles) as [name, child]}
                    {@const fullPath = path ? `${path}/${name}` : name}
                    {@const isOpen = expandedDirs.has(fullPath)}
                    <div class="tree-item">
                      <button class="tree-dir" onclick={() => toggleDir(fullPath)}>
                        <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                        <span class="tree-dir-name">{name}/</span>
                        <span class="tree-count">{child.totalFiles}</span>
                      </button>
                      {#if isOpen}
                        <div class="tree-children">
                          {@render unusedFolderChildren(child, fullPath)}
                          {#each child.files.sort() as file}
                            {@const filePath = fullPath ? `${fullPath}/${file}` : file}
                            {@const isMoved = movedFiles.has(filePath)}
                            {@const isMoving = movingFiles.has(filePath)}
                            <div class="tree-file tree-file--sample" class:tree-file--moved={isMoved}>
                              {#if !isMoved}
                                <button
                                  class="play-btn"
                                  class:play-btn--active={playingFile === filePath}
                                  onclick={() => playSample(filePath)}
                                  title={playingFile === filePath ? "Stop" : "Play"}
                                >{playingFile === filePath ? "◼" : "▶"}</button>
                              {/if}
                              <span class="tree-file-name">{file}</span>
                              {#if isMoved}
                                <span class="tree-file-badge">moved</span>
                              {:else if canWrite}
                                <button
                                  class="move-btn"
                                  onclick={() => moveSample(filePath)}
                                  disabled={isMoving}
                                  title="Move to {TRASH_DIR}/"
                                >{isMoving ? "..." : "×"}</button>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                {/snippet}
                {@render unusedFolderChildren(buildTree(report.unusedSamples), "")}
              </div>
            </div>
          {/if}

          {#if report.unusedPresets.length > 0}
            <div class="analysis-section">
              <h4 class="list-heading">Orphan presets ({report.unusedPresets.length})</h4>
              <div class="file-tree">
                {#snippet presetChildren(node: FolderNode, path: string)}
                  {#each [...node.children.entries()].sort((a, b) => b[1].totalFiles - a[1].totalFiles) as [name, child]}
                    {@const fullPath = path ? `${path}/${name}` : name}
                    {@const isOpen = expandedDirs.has(fullPath)}
                    <div class="tree-item">
                      <button class="tree-dir" onclick={() => toggleDir(fullPath)}>
                        <span class="tree-arrow">{isOpen ? "▾" : "▸"}</span>
                        <span class="tree-dir-name">{name}/</span>
                        <span class="tree-count">{child.totalFiles}</span>
                      </button>
                      {#if isOpen}
                        <div class="tree-children">
                          {@render presetChildren(child, fullPath)}
                          {#each child.files.sort() as file}
                            <div class="tree-file">{file}</div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                {/snippet}
                {@render presetChildren(presetsTree, "")}
              </div>
            </div>
          {/if}

          {#if report.duplicates.length > 0}
            <div class="analysis-section">
              <h4 class="list-heading">Duplicate samples ({report.duplicates.length} groups, {formatBytes(report.duplicateWastedBytes)} wasted)</h4>
              <div class="dup-list">
                {#each report.duplicates as group, i}
                  <div class="dup-group">
                    <div class="dup-header">
                      <span class="dup-label">Group {i + 1}</span>
                      <span class="dup-meta">{group.files.length} copies · {formatBytes(group.size)} each</span>
                    </div>
                    {#each group.files as filePath}
                      <div class="tree-file tree-file--sample">
                        <button
                          class="play-btn"
                          class:play-btn--active={playingFile === filePath}
                          onclick={() => playSample(filePath)}
                          title={playingFile === filePath ? "Stop" : "Play"}
                        >{playingFile === filePath ? "◼" : "▶"}</button>
                        <span class="tree-file-name" title={filePath}>{filePath.split("/").pop()}</span>
                        <span class="broken-ref-path" title={filePath}>{filePath.split("/").slice(0, -1).join("/")}/</span>
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if report.invalidXml.length > 0}
            <div class="analysis-section">
              <div class="songs-header">
                <h4 class="list-heading">Invalid XML files ({report.invalidXml.length})</h4>
                {#if canWrite && report.invalidXml.some(f => f.autoFixable && !fixedXmlFiles.has(f.path))}
                  <button class="btn btn-secondary btn-sm" onclick={fixAllXml}>Fix all</button>
                {/if}
              </div>
              <p class="list-subtext">
                Backs up the original to {REPAIR_BACKUP_DIR}/ first, then collapses duplicate attributes.
              </p>
              <div class="file-tree">
                {#each report.invalidXml as f}
                  {@const isFixed = fixedXmlFiles.has(f.path)}
                  {@const isFixing = fixingXmlFiles.has(f.path)}
                  {@const error = xmlFixErrors.get(f.path)}
                  <div class="tree-file tree-file--sample" class:tree-file--moved={isFixed}>
                    <span class="tree-file-name" title={f.path}>{f.path.split("/").pop()}</span>
                    <span class="broken-ref-path" title={f.path}>{f.path.split("/").slice(0, -1).join("/")}/</span>
                    {#if isFixed}
                      <span class="tree-file-badge">fixed</span>
                    {:else if !f.autoFixable}
                      <span class="tree-file-badge tree-file-badge--error">needs manual review</span>
                    {:else if canWrite}
                      <button
                        class="btn btn-secondary btn-sm"
                        onclick={() => fixXmlFile(f.path)}
                        disabled={isFixing}
                      >{isFixing ? "..." : "Fix"}</button>
                    {/if}
                    {#if error}
                      <span class="missing-source">{error}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if report.missingReferences.length > 0}
            <div class="analysis-section">
              <h4 class="list-heading">Broken references ({report.missingReferences.length})</h4>
              <p class="list-subtext">Samples referenced in song/kit/preset XML but not found on the card.</p>
              <div class="file-tree">
                {#each report.missingReferences as ref}
                  <div class="tree-file tree-file--missing">
                    <span class="tree-file-name" title={ref.sample}>{ref.sample.split("/").pop()}</span>
                    <span class="broken-ref-path" title={ref.sample}>{ref.sample}</span>
                    <div class="broken-ref-sources">
                      {#each ref.referencedBy as xmlPath}
                        <span class="broken-ref-source" title={xmlPath}>{xmlPath.split("/").pop()}</span>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if report.unusedSamples.length === 0 && report.unusedPresets.length === 0 && report.duplicates.length === 0 && report.invalidXml.length === 0 && report.missingReferences.length === 0}
            <p class="list-empty">No issues found.</p>
          {/if}
        </div>

      {:else if listCategory === "backup"}
        <div class="list-group">
          <p class="list-note">
            Backup copies real files off the card. To see <em>what changed</em> between two
            sessions, and put one old file back, use <a href="/history">History</a>.
          </p>
          {#if !hasFileSystemAccess}
            <p class="list-empty">Backup requires a Chromium-based browser with File System Access API.</p>
          {:else if !canWrite}
            <p class="list-empty">Backup requires direct folder access. Use "Choose folder" to open your card.</p>
          {:else if !backupHandle && !backupScanning}
            <div class="backup-pick">
              <p class="backup-intro">Pick a folder to back up your card into. Only new and changed files will be copied.</p>
              <button class="btn btn-accent" onclick={pickBackupDestination}>Choose backup folder</button>
            </div>
          {:else if backupScanning}
            <div class="backup-progress">
              <p class="status-msg">{backupProgress}</p>
              <div class="progress-bar">
                <div class="progress-fill" style="width: {backupProgressPct}%"></div>
              </div>
            </div>
          {:else if backupRunning}
            <div class="backup-progress">
              <p class="status-msg">{backupProgress}</p>
              <div class="progress-bar">
                <div class="progress-fill" style="width: {backupProgressPct}%"></div>
              </div>
              <p class="backup-running-detail">{backupCopiedCount} files copied ({formatBytes(backupCopiedBytes)})</p>
            </div>
          {:else if backupComplete}
            <div class="backup-complete">
              <p class="backup-success">Backup complete. {backupCopiedCount} file{backupCopiedCount === 1 ? "" : "s"} copied ({formatBytes(backupCopiedBytes)}).</p>
              <div class="backup-actions">
                <button class="btn btn-secondary" onclick={() => { backupComplete = false; computeBackupDiff(); }}>Re-scan</button>
                <button class="btn btn-secondary" onclick={() => { backupHandle = null; backupDiff = null; backupComplete = false; }}>Change folder</button>
              </div>
            </div>
          {:else if backupDiff}
            <div class="backup-summary">
              <div class="backup-dest">
                <span class="backup-dest-label">Destination:</span>
                <span class="backup-dest-name">{backupHandle?.name}</span>
                <button class="btn btn-secondary btn-sm" onclick={() => { backupHandle = null; backupDiff = null; }}>Change</button>
              </div>

              <div class="backup-stats">
                <span class="stat stat--new">{backupDiff.newFiles.length} new</span>
                <span class="stat stat--changed">{backupDiff.changedFiles.length} changed</span>
                <span class="stat">{backupDiff.unchangedCount} unchanged</span>
                {#if backupDiff.onlyInBackup.length > 0}
                  <span class="stat stat--warn">{backupDiff.onlyInBackup.length} only in backup</span>
                {/if}
              </div>

              {#if backupDiff.newFiles.length + backupDiff.changedFiles.length > 0}
                <div class="backup-copy-summary">
                  <span>{backupDiff.newFiles.length + backupDiff.changedFiles.length} files to copy ({formatBytes(backupDiff.totalCopyBytes)})</span>
                  <button class="btn btn-accent" onclick={runBackup}>Back Up Now</button>
                </div>
              {:else}
                <p class="backup-uptodate">Everything is up to date.</p>
              {/if}

              {#if backupDiff.newFiles.length > 0}
                <details class="backup-detail-list">
                  <summary>New files ({backupDiff.newFiles.length})</summary>
                  <div class="file-tree">
                    {#each backupDiff.newFiles as f}
                      <div class="tree-file">
                        <span class="tree-file-name" title={f.path}>{f.path}</span>
                        {#if f.size > 0}<span class="tree-file-size">{formatBytes(f.size)}</span>{/if}
                      </div>
                    {/each}
                  </div>
                </details>
              {/if}

              {#if backupDiff.changedFiles.length > 0}
                <details class="backup-detail-list">
                  <summary>Changed files ({backupDiff.changedFiles.length})</summary>
                  <div class="file-tree">
                    {#each backupDiff.changedFiles as f}
                      <div class="tree-file">
                        <span class="tree-file-name" title={f.path}>{f.path}</span>
                        {#if f.size > 0}<span class="tree-file-size">{formatBytes(f.size)}</span>{/if}
                      </div>
                    {/each}
                  </div>
                </details>
              {/if}

              {#if backupDiff.onlyInBackup.length > 0}
                <details class="backup-detail-list">
                  <summary>Only in backup ({backupDiff.onlyInBackup.length})</summary>
                  <div class="file-tree">
                    {#each backupDiff.onlyInBackup as f}
                      <div class="tree-file">
                        <span class="tree-file-name" title={f}>{f}</span>
                      </div>
                    {/each}
                  </div>
                </details>
              {/if}
            </div>
          {/if}

          {#if backupError}
            <p class="backup-error">{backupError}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>

{:else if state === "error"}
  <div class="error-card">
    <p class="error-msg">{errorMsg}</p>
    <button class="btn btn-secondary" onclick={reset}>Try again</button>
  </div>
{/if}

<style>
  .dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 4rem 2rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.05s, background 0.05s;
  }
  .dropzone:hover,
  .dropzone--over {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .dropzone:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .dropzone-icon {
    font-family: 'DM Mono', monospace;
    font-size: 2.5rem;
    display: block;
    margin-bottom: 0.75rem;
    opacity: 0.7;
  }
  .dropzone-title {
    font-family: 'DM Mono', monospace;
    font-size: 1rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
  }
  .dropzone-sub {
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
  .dropzone-browse {
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    background: none;
    border: none;
    font: inherit;
    padding: 0;
  }
  .dropzone-hint {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin-top: 0.75rem;
    opacity: 0.7;
  }
  .dropzone-hint-warn {
    color: var(--accent);
    opacity: 1;
  }

  .status-card, .error-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2rem;
  }
  .status-msg {
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }
  .progress-bar {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill--indeterminate {
    height: 100%;
    width: 30%;
    background: var(--accent);
    border-radius: 2px;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  .summary-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
  }
  .summary-title {
    font-family: 'DM Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }
  .summary-divider {
    height: 1px;
    background: var(--border);
    margin-bottom: 1rem;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .stat-value {
    font-family: 'DM Mono', monospace;
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--text);
  }
  .stat--warn .stat-value { color: var(--accent); }
  .stat--error .stat-value { color: #c47a7a; }
  .stat--clickable {
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    border-radius: 4px;
    padding: 0.25rem 0.35rem;
    margin: -0.25rem -0.35rem;
    transition: background 0.15s;
  }
  .stat--clickable:hover {
    background: rgba(128, 128, 128, 0.1);
  }
  .stat-label {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .clean-msg {
    margin-top: 1rem;
    font-size: 0.88rem;
    color: var(--teal);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  .list-section {
    margin-top: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .list-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .list-tab {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 0.6rem 1rem;
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .list-tab:hover { color: var(--text); }
  .list-tab--active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .list-group {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .list-group:last-child { border-bottom: none; }
  .list-heading {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 0.4rem;
  }
  .file-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 400px;
    overflow-y: auto;
  }
  .file-list li {
    padding: 0.2rem 0;
    color: var(--text);
  }
  .missing-sample {
    color: var(--text);
  }
  .missing-source {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin-left: 0.5rem;
  }
  .broken-ref-path {
    font-size: 0.65rem;
    color: var(--text-secondary);
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 0.25rem;
  }
  .broken-ref-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding-left: 0.25rem;
    margin-bottom: 0.25rem;
  }
  .broken-ref-source {
    font-size: 0.62rem;
    color: var(--text-secondary);
    background: rgba(128, 128, 128, 0.1);
    border-radius: 3px;
    padding: 0 0.3rem;
    cursor: default;
  }
  .sample-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .sample-search {
    flex: 1;
    min-width: 140px;
    padding: 0.3rem 0.5rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    outline: none;
  }
  .sample-search:focus {
    border-color: var(--teal);
  }
  .sample-filter-btns {
    display: flex;
    gap: 0.25rem;
  }
  .sample-count {
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .btn-primary {
    background: var(--teal);
    color: #fff;
    border-color: var(--teal);
  }
  .tree-dir-row {
    display: flex;
    align-items: center;
  }
  .file-tree {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 70vh;
    overflow-y: auto;
  }
  .tree-item {
    margin: 0;
  }
  .tree-dir {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.25rem 0;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    text-align: left;
  }
  .tree-dir:hover {
    color: var(--accent);
  }
  .tree-arrow {
    width: 0.8rem;
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .tree-dir-name {
    font-weight: 500;
  }
  .tree-count {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin-left: auto;
  }
  .tree-children {
    padding-left: 1.1rem;
    border-left: 1px solid var(--border);
    margin-left: 0.35rem;
  }
  .tree-file {
    padding: 0.15rem 0;
    color: var(--text-secondary);
  }
  .tree-file--sample {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tree-file--moved {
    opacity: 0.4;
  }
  .tree-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-file-size {
    font-size: 0.65rem;
    color: var(--text-muted, #888);
    flex-shrink: 0;
    opacity: 0.7;
  }
  .tree-file-badge {
    font-size: 0.65rem;
    color: var(--teal);
    border: 1px solid var(--teal);
    border-radius: 3px;
    padding: 0 0.3rem;
    flex-shrink: 0;
  }
  .tree-file-badge--error {
    color: #c47a7a;
    border-color: #c47a7a;
  }
  .list-subtext {
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin: 0 0 0.5rem;
  }
  .play-btn {
    flex-shrink: 0;
    width: 1.4rem;
    height: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: none;
    color: var(--text-secondary);
    font-size: 0.6rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .play-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .play-btn--active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .move-btn {
    flex-shrink: 0;
    width: 1.4rem;
    height: 1.4rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: none;
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .move-btn:hover {
    color: #c47a7a;
    border-color: #c47a7a;
  }
  .move-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tree-file--missing {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    color: var(--text);
  }

  .songs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }
  .songs-header-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .list-subheading {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 0.6rem 0 0.3rem;
  }

  .dup-list {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    max-height: 500px;
    overflow-y: auto;
  }
  .dup-group {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .dup-group:last-child { border-bottom: none; }
  .dup-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.3rem;
  }
  .dup-label {
    font-weight: 500;
    color: var(--text);
  }
  .dup-meta {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .list-empty {
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .list-note {
    padding: 0.75rem 1rem;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
  }
  .list-note a {
    color: var(--accent);
  }

  .error-card { border-color: #c47a7a; }
  .error-msg {
    color: #c47a7a;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .btn {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 0.6rem 1.25rem;
    border-radius: 5px;
    border: none;
    cursor: pointer;
    transition: background 0.05s;
  }
  .btn-sm { padding: 0.4rem 0.9rem; font-size: 0.78rem; }
  .btn-secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: var(--surface); }
  .btn-accent {
    background: var(--accent);
    color: var(--bg);
    border: 1px solid var(--accent);
  }
  .btn-accent:hover { opacity: 0.9; }
  .btn-accent:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ref-count-btn {
    flex-shrink: 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    color: var(--teal);
    border: 1px solid var(--teal);
    border-radius: 3px;
    padding: 0 0.3rem;
    background: none;
    cursor: pointer;
  }
  .ref-count-btn:hover {
    background: var(--accent-dim);
  }
  .ref-list {
    padding-left: 2.2rem;
    padding-bottom: 0.25rem;
  }
  .ref-item {
    font-size: 0.7rem;
    color: var(--text-secondary);
    padding: 0.05rem 0;
  }

  .fix-all-result {
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    background: rgba(196, 122, 122, 0.12);
    font-size: 0.82rem;
  }
  .fix-all-result p { margin: 0; }
  .fix-all-result--success {
    background: rgba(90, 171, 172, 0.12);
  }
  .fix-all-details {
    margin: 0.25rem 0 0;
    padding-left: 1.2rem;
    font-size: 0.78rem;
    opacity: 0.85;
  }
  .analysis-section {
    padding-bottom: 1rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .analysis-section:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }

  .breadcrumb-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0.25rem 0.5rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .backup-pick {
    text-align: center;
    padding: 2rem 1rem;
  }
  .backup-intro {
    font-size: 0.88rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
  }
  .backup-progress {
    padding: 1rem 0;
  }
  .backup-running-detail {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-top: 0.5rem;
  }
  .backup-complete {
    padding: 1rem 0;
  }
  .backup-success {
    color: var(--teal);
    font-family: 'DM Mono', monospace;
    font-size: 0.88rem;
    margin-bottom: 0.75rem;
  }
  .backup-actions {
    display: flex;
    gap: 0.5rem;
  }
  .backup-summary {
    padding: 0.5rem 0;
  }
  .backup-dest {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    font-size: 0.82rem;
  }
  .backup-dest-label {
    color: var(--text-secondary);
  }
  .backup-dest-name {
    font-family: 'DM Mono', monospace;
    font-weight: 500;
  }
  .backup-stats {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  .backup-copy-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 0.75rem;
    background: rgba(90, 171, 172, 0.08);
    border: 1px solid rgba(90, 171, 172, 0.2);
    border-radius: 6px;
    font-size: 0.82rem;
    margin-bottom: 0.75rem;
  }
  .backup-uptodate {
    font-family: 'DM Mono', monospace;
    font-size: 0.88rem;
    color: var(--teal);
    padding: 0.5rem 0;
  }
  .backup-detail-list {
    margin-top: 0.5rem;
    font-size: 0.82rem;
  }
  .backup-detail-list summary {
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0.3rem 0;
  }
  .backup-detail-list .file-tree {
    max-height: 300px;
    overflow-y: auto;
    padding-left: 0.5rem;
  }
  .backup-error {
    color: #c47a7a;
    font-size: 0.82rem;
    margin-top: 0.5rem;
  }
  .stat--new {
    color: var(--teal);
    border-color: var(--teal);
  }
  .stat--changed {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
