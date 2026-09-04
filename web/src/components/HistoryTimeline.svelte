<script lang="ts">
  import { onMount } from "svelte";
  import { cardStore } from "../lib/cardStore";
  import { historyStore, type SavePoint, type SaveKind, type StorageUsage } from "../lib/historyStore";
  import { compareSavePoints, diffXml, musicalChanges, type FieldChange, type FileChange } from "../lib/xmlDiff";
  import { historyVault } from "../lib/historyVault";
  import { restoreFile } from "../lib/softDelete";
  import { trackToolAction } from "../lib/analytics";

  type Kind = SaveKind | "all";

  let savePoints: SavePoint[] = $state([]);
  let selectedId: number | null = $state(null);
  let compareId: number | null = $state(null);
  let kindFilter: Kind = $state("all");
  let expanded: Record<string, FieldChange[]> = $state({});
  let showViewOnly: Record<string, boolean> = $state({});
  let usage: StorageUsage | null = $state(null);
  let cardConnected = $state(false);
  let cardName = $state("");
  let busy = $state("");
  let notice = $state("");
  let errorMsg = $state("");
  let newLabel = $state("");
  let vaultName = $state("");
  let vaultConnected = $state(false);
  let offerMigrate = $state(0);

  const KIND_NAMES: Record<SaveKind, string> = { song: "Songs", kit: "Kits", patch: "Patches" };

  onMount(async () => {
    try {
      vaultConnected = await historyVault.reconnect();
      vaultName = historyVault.name;
    } catch {
      vaultConnected = false;
    }
    await refresh();
    try {
      cardConnected = cardStore.isLoaded || (await cardStore.reconnect());
      cardName = cardStore.rootHandle?.name ?? "";
    } catch {
      cardConnected = false;
    }
  });

  async function chooseVault() {
    errorMsg = "";
    notice = "";
    try {
      await historyVault.pick();
      vaultConnected = true;
      vaultName = historyVault.name;
      selectedId = null;
      compareId = null;
      expanded = {};
      await refresh();
      offerMigrate = await historyStore.browserSavePointCount();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Could not open that folder";
    }
  }

  async function useBrowserStorage() {
    await historyVault.forget();
    vaultConnected = false;
    vaultName = "";
    offerMigrate = 0;
    selectedId = null;
    compareId = null;
    expanded = {};
    await refresh();
  }

  async function migrate() {
    busy = "Copying save points into the folder";
    try {
      const { moved, skipped } = await historyStore.migrateToVault();
      notice =
        `Copied ${moved} save points into ${vaultName}.` +
        (skipped ? ` ${skipped} could not be copied — their stored files were already gone.` : "") +
        " The browser copies are left as they were.";
      offerMigrate = 0;
      await refresh();
      trackToolAction("history", "migrate", { moved, skipped });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Could not copy the save points";
    } finally {
      busy = "";
    }
  }

  async function refresh() {
    savePoints = await historyStore.listSavePoints();
    usage = await historyStore.estimateUsage();
    if (selectedId === null && savePoints.length) selectedId = savePoints[0].id;
  }

  async function connectCard() {
    errorMsg = "";
    try {
      await cardStore.pickDirectory();
      cardConnected = true;
      cardName = cardStore.rootHandle?.name ?? "";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Could not open the card";
    }
  }

  /**
   * Drops the current card and asks for another folder. Save points already taken are kept and
   * still comparable, which is the point: it is how one backup folder is compared with another.
   */
  async function resetCard() {
    errorMsg = "";
    notice = "";
    cardStore.reset();
    cardConnected = false;
    cardName = "";
    await connectCard();
  }

  async function takeSavePoint() {
    errorMsg = "";
    notice = "";
    busy = "Taking save point";
    try {
      if (!cardStore.isLoaded) await cardStore.reconnect();
      const saved = await historyStore.createSavePoint(
        {
          cardName: cardStore.rootHandle?.name ?? "card",
          songXmls: cardStore.songXmls,
          presetIndex: cardStore.presetIndex,
        },
        newLabel.trim() || undefined,
      );
      newLabel = "";
      await refresh();
      selectedId = saved.id;
      compareId = null;
      expanded = {};
      const changedCount = previousOf(saved)
        ? compareSavePoints(previousOf(saved)!, saved).filter((f) => f.status !== "unchanged").length
        : saved.entries.length;
      notice = `Saved ${saved.entries.length} files. ${changedCount} changed since the one before.`;
      trackToolAction("history", "save_point", { files: saved.entries.length, changed: changedCount });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Could not take a save point";
    } finally {
      busy = "";
    }
  }

  function previousOf(savePoint: SavePoint): SavePoint | null {
    const index = savePoints.findIndex((s) => s.id === savePoint.id);
    return index >= 0 && index + 1 < savePoints.length ? savePoints[index + 1] : null;
  }

  const after = $derived(savePoints.find((s) => s.id === selectedId) ?? null);
  const before = $derived(
    compareId !== null
      ? (savePoints.find((s) => s.id === compareId) ?? null)
      : after
        ? previousOf(after)
        : null,
  );

  const fileChanges = $derived.by((): FileChange[] => {
    if (!after || !before) return [];
    return compareSavePoints(before, after).filter(
      (f) => f.status !== "unchanged" && (kindFilter === "all" || f.kind === kindFilter),
    );
  });

  const counts = $derived.by(() => {
    const all = after && before ? compareSavePoints(before, after) : [];
    return {
      changed: all.filter((f) => f.status === "changed").length,
      added: all.filter((f) => f.status === "added").length,
      removed: all.filter((f) => f.status === "removed").length,
    };
  });

  async function toggleFile(file: FileChange) {
    if (expanded[file.path]) {
      const next = { ...expanded };
      delete next[file.path];
      expanded = next;
      return;
    }
    if (file.status !== "changed" || !file.beforeHash || !file.afterHash) return;
    const [oldXml, newXml] = await Promise.all([
      historyStore.getXml(file.beforeHash),
      historyStore.getXml(file.afterHash),
    ]);
    if (oldXml === null || newXml === null) {
      errorMsg = `The stored copy of ${file.path} is gone, so it cannot be compared.`;
      return;
    }
    expanded = { ...expanded, [file.path]: diffXml(oldXml, newXml) };
    trackToolAction("history", "diff");
  }

  async function restore(file: FileChange) {
    const hash = file.beforeHash;
    if (!hash) return;
    if (!cardStore.rootHandle) {
      errorMsg = "Connect the card before restoring.";
      return;
    }
    if (!confirm(`Put the older version of ${file.path} back on the card?`)) return;
    errorMsg = "";
    busy = `Restoring ${file.path}`;
    try {
      const xml = await historyStore.getXml(hash);
      if (xml === null) throw new Error("The stored copy is gone");
      const result = await restoreFile(cardStore.rootHandle, file.path, xml);
      notice = result.created
        ? `${file.path} was put back on the card.`
        : `${file.path} restored. The version that was there is in HISTORY_BACKUP.`;
      trackToolAction("history", "restore");
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Restore failed";
    } finally {
      busy = "";
    }
  }

  async function remove(savePoint: SavePoint) {
    if (!confirm(`Delete save point "${savePoint.label}"? The card is not touched.`)) return;
    await historyStore.deleteSavePoint(savePoint.id);
    if (selectedId === savePoint.id) selectedId = null;
    if (compareId === savePoint.id) compareId = null;
    expanded = {};
    await refresh();
    trackToolAction("history", "prune");
  }

  async function exportOne(savePoint: SavePoint) {
    const json = await historyStore.exportSavePoint(savePoint.id);
    if (!json) return;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `save-point-${savePoint.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
    trackToolAction("history", "export_save_point");
  }

  function pickCompare(id: number) {
    compareId = compareId === id ? null : id;
    expanded = {};
  }

  function select(id: number) {
    selectedId = id;
    expanded = {};
  }

  function viewOnlyCount(changes: FieldChange[]): number {
    return changes.length - musicalChanges(changes).length;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTime(takenAt: number): string {
    return new Date(takenAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="history">
  <header class="bar">
    <div class="bar-left">
      <input
        class="label-input"
        bind:value={newLabel}
        placeholder="Name this save point (optional)"
        aria-label="Save point name"
      />
      <button class="primary" onclick={takeSavePoint} disabled={!!busy}>
        {busy ? busy : "Take save point"}
      </button>
    </div>
    <div class="bar-right">
      {#if cardConnected}
        <span class="card-name">card: {cardName || "connected"}</span>
        <button class="tiny" onclick={resetCard} title="Use a different card or backup folder">
          Reset card
        </button>
      {:else}
        <button class="ghost" onclick={connectCard}>Connect card</button>
      {/if}
      <span class="count">{savePoints.length} save points</span>
    </div>
  </header>

  <div class="home">
    {#if vaultConnected}
      <span class="home-label">saved to folder: <strong>{vaultName}</strong></span>
      <button class="tiny" onclick={chooseVault}>change folder</button>
      <button class="tiny" onclick={useBrowserStorage}>use browser storage</button>
    {:else}
      <span class="home-label">
        saved in this browser only — clearing site data loses them
      </span>
      <button class="tiny" onclick={chooseVault}>Choose a folder</button>
    {/if}
  </div>

  {#if offerMigrate > 0}
    <p class="notice">
      You have {offerMigrate} save points in browser storage. Copy them into {vaultName}?
      <button class="tiny" onclick={migrate} disabled={!!busy}>copy them across</button>
      <button class="tiny" onclick={() => (offerMigrate = 0)}>leave them</button>
    </p>
  {/if}

  {#if usage && usage.percent > 70}
    <p class="warn">
      Browser storage is {Math.round(usage.percent)}% full ({formatBytes(usage.usage)} of
      {formatBytes(usage.quota)}). Delete old save points, or export them.
    </p>
  {/if}
  {#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
  {#if notice}<p class="notice">{notice}</p>{/if}

  {#if savePoints.length === 0}
    <p class="empty">
      No save points yet. Connect your card and take one — it records every song, kit and patch,
      and costs almost nothing when little has changed. Samples are never included.
    </p>
  {:else}
    <div class="split">
      <ol class="timeline">
        {#each savePoints as savePoint (savePoint.id)}
          <li class:selected={savePoint.id === selectedId} class:compare={savePoint.id === compareId}>
            <button class="entry" onclick={() => select(savePoint.id)}>
              <span class="entry-label">{savePoint.label}</span>
              <span class="entry-meta">
                {formatTime(savePoint.takenAt)} · {savePoint.entries.length} files
              </span>
              <span class="entry-card">{savePoint.cardName}</span>
            </button>
            <div class="entry-actions">
              <button class="tiny" onclick={() => pickCompare(savePoint.id)} title="Compare against this one">
                {savePoint.id === compareId ? "comparing" : "compare"}
              </button>
              <button class="tiny" onclick={() => exportOne(savePoint)} title="Export as JSON">export</button>
              <button class="tiny danger" onclick={() => remove(savePoint)} title="Delete this save point">delete</button>
            </div>
          </li>
        {/each}
      </ol>

      <section class="diff">
        {#if !after}
          <p class="empty">Pick a save point.</p>
        {:else if !before}
          <p class="empty">
            This is the earliest save point, so there is nothing before it to compare against.
            It holds {after.entries.length} files.
          </p>
        {:else}
          <h2 class="diff-title">{before.label} → {after.label}</h2>
          <p class="diff-summary">
            {counts.changed} changed · {counts.added} added · {counts.removed} removed
          </p>
          {#if before.cardName !== after.cardName}
            <p class="cross-card">
              different cards: {before.cardName} → {after.cardName}. Paths are matched by name,
              so anything renamed between the two reads as one removed and one added.
            </p>
          {/if}
          <div class="filters">
            {#each ["all", "song", "kit", "patch"] as kind (kind)}
              <button
                class="tiny"
                class:active={kindFilter === kind}
                onclick={() => (kindFilter = kind as Kind)}
              >
                {kind === "all" ? "All" : KIND_NAMES[kind as SaveKind]}
              </button>
            {/each}
          </div>

          {#if fileChanges.length === 0}
            <p class="empty">Nothing changed between these two.</p>
          {:else}
            <ul class="files">
              {#each fileChanges as file (file.path)}
                <li>
                  <div class="file-row">
                    <button
                      class="file-name"
                      onclick={() => toggleFile(file)}
                      disabled={file.status !== "changed"}
                    >
                      <span class="status status-{file.status}">{file.status}</span>
                      <span>{file.path}</span>
                    </button>
                    {#if file.beforeHash}
                      <button class="tiny" onclick={() => restore(file)} disabled={!!busy}>
                        restore this version
                      </button>
                    {/if}
                  </div>

                  {#if expanded[file.path]}
                    {@const changes = expanded[file.path]}
                    {@const musical = musicalChanges(changes)}
                    <ul class="fields">
                      {#each musical as change (change.path)}
                        <li><span class="field-label">{change.label}</span><span class="field-value">{change.summary}</span></li>
                      {/each}
                      {#if musical.length === 0}
                        <li class="muted">Nothing musical changed.</li>
                      {/if}
                      {#if viewOnlyCount(changes) > 0}
                        <li>
                          <button
                            class="tiny"
                            onclick={() => (showViewOnly = { ...showViewOnly, [file.path]: !showViewOnly[file.path] })}
                          >
                            {showViewOnly[file.path] ? "hide" : "show"}
                            {viewOnlyCount(changes)} view-only changes
                          </button>
                        </li>
                        {#if showViewOnly[file.path]}
                          {#each changes.filter((c) => c.viewOnly) as change (change.path)}
                            <li class="muted">
                              <span class="field-label">{change.label}</span><span class="field-value">{change.summary}</span>
                            </li>
                          {/each}
                        {/if}
                      {/if}
                    </ul>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .history {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    justify-content: space-between;
    align-items: center;
  }
  .bar-left,
  .bar-right {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .label-input {
    font-family: "DM Sans", sans-serif;
    font-size: 0.85rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    min-width: 14rem;
  }
  button {
    font-family: "DM Mono", monospace;
    font-size: 0.8rem;
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    padding: 0.45rem 0.75rem;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
  }
  .tiny {
    font-size: 0.7rem;
    padding: 0.2rem 0.45rem;
  }
  .tiny.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .danger:hover {
    border-color: #c25b5b;
    color: #c25b5b;
  }
  .home {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  .home-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .card-name,
  .count {
    font-family: "DM Mono", monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .split {
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
    gap: 1.5rem;
    align-items: start;
  }
  @media (max-width: 700px) {
    .split {
      grid-template-columns: 1fr;
    }
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    max-height: 32rem;
    overflow-y: auto;
  }
  .timeline li {
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.5rem;
  }
  .timeline li:last-child {
    border-bottom: none;
  }
  .timeline li.selected {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .timeline li.compare {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .entry {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    border: none;
    padding: 0.2rem 0;
    text-align: left;
  }
  .entry-label {
    font-size: 0.82rem;
  }
  .entry-meta {
    font-size: 0.68rem;
    color: var(--text-secondary);
  }
  .entry-card {
    font-family: "DM Mono", monospace;
    font-size: 0.62rem;
    color: var(--text-secondary);
    opacity: 0.8;
  }
  .cross-card {
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--accent);
    margin: -0.4rem 0 0.75rem;
  }
  .entry-actions {
    display: flex;
    gap: 0.3rem;
  }
  .diff-title {
    font-family: "DM Mono", monospace;
    font-size: 0.95rem;
    margin: 0 0 0.2rem;
  }
  .diff-summary {
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }
  .filters {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .files > li {
    border-top: 1px solid var(--border);
    padding: 0.5rem 0;
  }
  .file-row {
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
    align-items: center;
  }
  .file-name {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    border: none;
    padding: 0;
    font-family: "DM Mono", monospace;
    font-size: 0.8rem;
    text-align: left;
  }
  .status {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    border: 1px solid var(--border);
  }
  .status-changed {
    color: var(--accent);
    border-color: var(--accent);
  }
  .status-added {
    color: var(--secondary);
    border-color: var(--secondary);
  }
  .status-removed {
    color: #c25b5b;
    border-color: #c25b5b;
  }
  .fields {
    list-style: none;
    margin: 0.5rem 0 0 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .fields li {
    display: flex;
    gap: 0.75rem;
    font-size: 0.78rem;
  }
  .field-label {
    min-width: 12rem;
    color: var(--text-secondary);
  }
  .field-value {
    font-family: "DM Mono", monospace;
  }
  .muted {
    color: var(--text-secondary);
  }
  .empty,
  .notice,
  .warn,
  .error {
    font-size: 0.85rem;
    line-height: 1.55;
    margin: 0;
  }
  .empty {
    color: var(--text-secondary);
  }
  .warn {
    color: var(--accent);
  }
  .error {
    color: #c25b5b;
  }
</style>
