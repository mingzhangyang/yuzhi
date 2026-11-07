import { isStorageUnavailableError } from '../db';
import { t } from '../i18n';
import { esc, setHTML } from './dom';
import { readSettlementSnapshot, type SettlementSnapshot } from './settlement-backup';

/** Stop startup visibly; an unreadable database must never look like a new island. */
export function showStartupError(error: unknown, actions: { retry(): void; exportSnapshot(snapshot: SettlementSnapshot): void }) {
  const wrap = document.querySelector<HTMLElement>('.wrap');
  if (!wrap) return;
  const message = isStorageUnavailableError(error)
    ? t('main.storageUnavailable')
    : error instanceof Error ? error.message : String(error);
  setHTML(wrap, `<section class="card panel" role="alert" style="max-width:760px;margin:48px auto">
    <h2>${esc(t('main.openDataTitle'))}</h2>
    <p>${esc(message)}</p>
    <p>${esc(t('main.openDataBody'))}</p>
    <div class="btnrow"><button class="btn primary" type="button" data-retry-startup>${esc(t('main.openDataRetry'))}</button><button class="btn" type="button" data-export-startup-snapshot hidden>${esc(t('safety.snapshotExport'))}</button></div>
  </section>`);
  const retry = wrap.querySelector<HTMLButtonElement>('[data-retry-startup]');
  retry?.addEventListener('click', () => { retry.disabled = true; actions.retry(); });
  retry?.focus();
  const exportButton = wrap.querySelector<HTMLButtonElement>('[data-export-startup-snapshot]');
  void readSettlementSnapshot().then((snapshot) => {
    if (!snapshot || !exportButton?.isConnected) return;
    exportButton.hidden = false;
    exportButton.addEventListener('click', () => actions.exportSnapshot(snapshot));
  }).catch(() => { /* the separate snapshot store may also be unavailable */ });
}
