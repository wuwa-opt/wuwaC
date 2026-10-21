import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_BACKUP_BYTES } from '../readFile.ts';
import { fakeSizedFile } from '../testFile.ts';
import { DataSafety } from './DataSafety.tsx';

const backupJson = JSON.stringify({
  format: 'wuwa-optimizer-backup',
  version: 1,
  exportedAt: '2026-10-21T00:00:00.000Z',
  tables: { ownedEchoes: [], roster: [], builds: [], teams: [] },
});

describe('DataSafety restore file', () => {
  it('refuses an oversized backup before reading it', async () => {
    const user = userEvent.setup();
    render(<DataSafety onToast={vi.fn()} />);
    const { file, text } = fakeSizedFile(MAX_BACKUP_BYTES + 1, 'backup.json');
    await user.upload(screen.getByLabelText(/backup file to restore/i), file);
    expect(await screen.findByRole('alert')).toHaveTextContent(/over the 16\.0 MB limit for a backup/);
    expect(text).not.toHaveBeenCalled();
    expect(screen.queryByRole('status', { name: /restore/i })).not.toBeInTheDocument();
  });

  it('still accepts a normal backup', async () => {
    const user = userEvent.setup();
    render(<DataSafety onToast={vi.fn()} />);
    const file = new File([backupJson], 'backup.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText(/backup file to restore/i), file);
    expect(await screen.findByText(/backup\.json/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
