import { useEffect, useRef, useState } from 'react';
import {
  countBackup,
  parseBackup,
  restoreBackup,
  type Backup,
  type BackupCounts,
  type RestoreMode,
} from '../../state/backup.ts';
import { requestPersistentStorage, storageStatus, type StorageStatus } from '../../state/persistence.ts';
import { downloadBackup } from '../download.ts';
import { MAX_BACKUP_BYTES, readTextFile } from '../readFile.ts';
import { btnDangerGhost, btnGhost, btnOutline, btnPrimary } from './classes.ts';
import { Alert, Window } from './ui.tsx';

function describeCounts(c: BackupCounts): string {
  const part = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    part(c.ownedEchoes, 'echo', 'echoes'),
    part(c.roster, 'character', 'characters'),
    part(c.builds, 'build', 'builds'),
    part(c.teams, 'team', 'teams'),
  ].join(', ');
}

const STATUS_TEXT: Record<StorageStatus, string> = {
  persistent: 'Persistent — the browser will not evict it.',
  'best-effort': 'Best-effort — the browser may clear it under storage pressure.',
  unsupported: 'Unknown — this browser cannot report storage persistence.',
};

/** Storage status + whole-database export/restore (Database page). */
export function DataSafety({ onToast }: { onToast: (message: string, tone?: 'success' | 'danger') => void }) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [pending, setPending] = useState<{ backup: Backup; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void storageStatus().then(setStatus);
  }, []);

  const handleExport = async (): Promise<void> => {
    setError(null);
    try {
      const backup = await downloadBackup();
      onToast(`Backed up ${describeCounts(countBackup(backup))}.`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the backup.');
    }
  };

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(null);
    try {
      setPending({ backup: parseBackup(JSON.parse(await readTextFile(file, MAX_BACKUP_BYTES, 'a backup')) as unknown), fileName: file.name });
    } catch (err) {
      setPending(null);
      setError(err instanceof SyntaxError ? 'That file is not valid JSON.' : err instanceof Error ? err.message : String(err));
    }
  };

  const handleRestore = async (mode: RestoreMode): Promise<void> => {
    if (pending === null) return;
    setBusy(true);
    try {
      const counts = await restoreBackup(pending.backup, mode);
      onToast(`Restored ${describeCounts(counts)}.`, 'success');
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed; nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Window title="Your data" bar="b" className="mt-6">
      <p className="text-sm text-fog">
        Everything you enter stays in this browser — nothing is uploaded. Clearing site data, or the browser
        evicting it, erases it, so keep a backup.
      </p>
      <p className="mt-2 text-sm text-ink" aria-live="polite">
        <span className="font-bold">Storage:</span> {status === null ? 'Checking…' : STATUS_TEXT[status]}
        {status === 'best-effort' && (
          <button
            type="button"
            className={`${btnGhost} ml-2`}
            onClick={() => void requestPersistentStorage().then(setStatus)}
          >
            Ask to keep it
          </button>
        )}
      </p>

      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={() => void handleExport()} className={btnPrimary}>
          Export everything
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} className={btnOutline}>
          Restore from backup…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          aria-label="Backup file to restore"
          className="sr-only"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      {pending && (
        <Alert tone="info" role="status" className="mt-3">
          <p>
            <span className="font-bold">{pending.fileName}</span> (from {pending.backup.exportedAt.slice(0, 10)}) holds{' '}
            {describeCounts(countBackup(pending.backup))}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void handleRestore('merge')} className={btnOutline}>
              Merge into current data
            </button>
            <button type="button" disabled={busy} onClick={() => void handleRestore('replace')} className={btnDangerGhost}>
              Replace all current data
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)} className={btnGhost}>
              Cancel
            </button>
          </div>
        </Alert>
      )}
    </Window>
  );
}
