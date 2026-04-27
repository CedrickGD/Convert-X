<script>
  import { WEB_URL } from "../lib/github.js";
</script>

<div class="web-link">
  <div class="copy">
    <div class="title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      Open the Web Version
    </div>
    <p class="reason">
      Same converter in your browser — no install, share-friendly URL. Useful when you're on a different machine or want to send a quick link to someone.
    </p>
  </div>

  <div class="actions">
    <a class="btn primary" href={WEB_URL} target="_blank" rel="noopener noreferrer">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Open in browser
    </a>
    <div class="meta"><span>convert-x-online.pages.dev</span></div>
  </div>
</div>

<style>
  .web-link {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .copy { display: flex; flex-direction: column; gap: 4px; }

  .title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .reason {
    font-size: 0.78rem;
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0;
  }

  .actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 0.82rem;
    letter-spacing: -0.01em;
    text-decoration: none;
  }

  .btn.primary {
    background: var(--accent);
    color: var(--btn-primary-text);
  }

  .btn.primary:hover {
    background: var(--accent-hover);
    box-shadow: 0 0 18px var(--accent-glow), 0 4px 10px rgba(0, 0, 0, 0.25);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
</style>
