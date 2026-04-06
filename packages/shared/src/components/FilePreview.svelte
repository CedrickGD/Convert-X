<script>
  import { getPlatform } from "../platform.js";
  import { onDestroy } from "svelte";

  export let metadata;
  export let filePath = "";
  export let fileObj = null;
  export let compact = false;

  let previewUrl = "";
  let loadedRef = "";

  $: kind = metadata?.mimeType?.startsWith("video") ? "video"
    : metadata?.mimeType?.startsWith("audio") ? "audio" : "image";

  $: fileRef = filePath || (fileObj ? fileObj.name : "");
  $: if (fileRef && fileRef !== loadedRef && (kind === "image" || kind === "video")) {
    loadPreview(fileRef, kind);
  }

  async function loadPreview(ref, fileKind) {
    loadedRef = ref;
    cleanupUrl();
    try {
      if (fileObj) {
        previewUrl = URL.createObjectURL(fileObj);
      } else {
        const buffer = await getPlatform().readFileBinary(filePath);
        const ext = filePath.split(".").pop().toLowerCase();
        let mime;
        if (fileKind === "image") {
          const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", tiff: "image/tiff", tif: "image/tiff", ico: "image/x-icon", avif: "image/avif" };
          mime = map[ext] || "image/png";
        } else {
          const map = { mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4" };
          mime = map[ext] || "video/mp4";
        }
        const blob = new Blob([buffer], { type: mime });
        previewUrl = URL.createObjectURL(blob);
      }
    } catch (e) {
      previewUrl = "";
    }
  }

  function cleanupUrl() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
  }

  onDestroy(cleanupUrl);

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
</script>

<div class="preview" class:compact>
  {#if previewUrl && kind === "image"}
    <div class="media-preview">
      <img src={previewUrl} alt="Preview" class="media-img" />
    </div>
  {/if}

  <div class="meta-row">
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
</div>

<style>
  .preview {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    animation: fadeUp 0.3s ease-out;
  }

  .preview.compact {
    padding: 0;
  }

  .media-preview {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .media-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }

  .meta-row {
    display: flex;
    gap: 12px;
    padding: 14px;
    align-items: center;
  }

  .preview.compact .meta-row {
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
