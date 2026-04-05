<script>
  export let metadata;
  export let compact = false;

  function fmtSize(bytes) {
    if (!bytes) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let s = bytes, i = 0;
    while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
    return `${s.toFixed(1)} ${u[i]}`;
  }

  function fmtDuration(sec) {
    if (!sec) return null;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
      : `${m}:${String(s).padStart(2,"0")}`;
  }

  $: kind = metadata?.mimeType?.startsWith("video") ? "video"
    : metadata?.mimeType?.startsWith("audio") ? "audio" : "image";
</script>

<div class="preview" class:compact>
  <div class="badge {kind}">
    {#if kind === "video"}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    {:else if kind === "audio"}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    {:else}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    {/if}
  </div>

  <div class="info">
    <p class="name">{metadata?.fileName || "Unknown"}</p>
    <div class="tags">
      {#if metadata?.codec}<span class="tag">{metadata.codec}</span>{/if}
      {#if metadata?.resolution}<span class="tag">{metadata.resolution}</span>{/if}
      {#if metadata?.duration}<span class="tag">{fmtDuration(metadata.duration)}</span>{/if}
      {#if metadata?.bitrate}<span class="tag">{metadata.bitrate}</span>{/if}
      {#if metadata?.frameRate}<span class="tag">{metadata.frameRate} fps</span>{/if}
      <span class="tag">{fmtSize(metadata?.size)}</span>
    </div>
  </div>
</div>

<style>
  .preview {
    display: flex;
    gap: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    align-items: center;
    animation: fadeUp 0.3s ease-out;
  }

  .preview.compact {
    padding: 10px 14px;
  }

  .badge {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-xs);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .badge.video { background: rgba(96, 165, 250, 0.1); color: #60a5fa; }
  .badge.audio { background: rgba(192, 132, 252, 0.1); color: #c084fc; }
  .badge.image { background: rgba(52, 211, 153, 0.1); color: #34d399; }

  .info {
    flex: 1;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 6px;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tag {
    padding: 2px 8px;
    background: var(--bg-secondary);
    border-radius: 100px;
    font-size: 0.68rem;
    color: var(--text-muted);
    font-weight: 500;
    white-space: nowrap;
  }
</style>
