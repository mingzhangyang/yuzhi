export const v1BackupFixture = {
  format: 'yuzhi-backup',
  version: 1,
  exportedAt: '2026-10-02T12:00:00.000Z',
  settings: { workStart: '09:00', workEnd: '18:00', firstDay: '2026-10-01', theme: 'auto' },
  projects: [
    {
      id: 'p1', name: '团队', createdAt: '2026-10-01', lastProgressAt: '2026-10-01', status: 'active', islandSlot: 0,
      resets: [{ date: '2026-10-01', neglect: 0, kind: 'restart' }], lastStage: 0,
    },
  ],
  tasks: [
    { id: 't1', projectId: 'p1', title: '写周报', scheduledFor: '2026-10-02', postponeCount: 1, status: 'open', createdAt: '2026-10-01' },
    { id: 't2', projectId: 'p1', title: '回邮件', scheduledFor: '2026-10-01', postponeCount: 0, status: 'open', createdAt: '2026-10-01' },
  ],
  entries: [
    { id: '2026-10-01|task|t1', date: '2026-10-01', itemType: 'task', itemId: 't1', outcome: 'skipped', reason: 'postponed', projectId: 'p1', title: '写周报' },
    { id: '2026-10-01|task|t2', date: '2026-10-01', itemType: 'task', itemId: 't2', outcome: 'skipped', reason: 'interrupted', projectId: 'p1', title: '回邮件' },
  ],
  days: [{ date: '2026-10-01', status: 'settled' }],
  chronicle: [{ id: 'day|2026-10-01', date: '2026-10-01', text: '今天留下了两条记录。', kind: 'day' }],
  life: [
    { id: 'l-start', date: '2026-10-01', projectId: 'p1', text: '立项，村落「团队」在岛上落成', kind: 'start' },
    { id: 'l|2026-10-01|task|t1', date: '2026-10-01', projectId: 'p1', taskId: 't1', text: '「写周报」没做：推到明天', kind: 'skip', reason: 'postponed' },
    { id: 'l|2026-10-01|task|t2', date: '2026-10-01', projectId: 'p1', taskId: 't2', text: '「回邮件」没做：被打断', kind: 'skip', reason: 'interrupted' },
  ],
  interruptions: [{ id: 'i|2026-10-01|task|t2', date: '2026-10-01', itemType: 'task', itemId: 't2', title: '回邮件', projectId: 'p1' }],
  snapshots: [{ date: '2026-10-01', backlog: 1 }],
} as const;
