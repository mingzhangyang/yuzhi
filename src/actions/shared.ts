/**
 * Shared mutation primitives for action domains.
 * These helpers write facts inside an existing Store.batch boundary; they do
 * not create their own transaction.
 */
import type {
  ChronicleKind,
  ISODate,
  OperationEvent,
  OperationKind,
  OperationLifeSnapshot,
  Outcome,
  SettlementEntry,
  SkipReason,
} from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { entryId, type SettleItem } from '../logic/days';
import { nextFactSeq } from '../logic/operations';

export const REASON_TEXT: Record<SkipReason, string> = {
  interrupted: '被打断',
  no_energy: '没精力',
  not_important: '不重要了',
  postponed: '推到明天',
};

export class ActionError extends Error {}

export const q = (s: string) => `「${s}」`;

export function chronicle(store: Store, date: ISODate, text: string, kind: ChronicleKind, id = uid('c')) {
  store.put('chronicle', { id, date, text, kind });
}

export function operation(
  store: Store,
  o: {
    date?: ISODate;
    kind: OperationKind;
    projectId?: string;
    taskId?: string;
    subjectType?: OperationEvent['subjectType'];
    subjectId?: string;
    payload?: OperationEvent['payload'];
    life?: OperationLifeSnapshot[];
  },
) {
  const payload = o.life?.length ? { ...(o.payload ?? {}), life: o.life } : o.payload;
  const event: OperationEvent = {
    id: uid('o'),
    seq: nextFactSeq(store.data),
    date: o.date ?? store.today(),
    kind: o.kind,
    projectId: o.projectId,
    taskId: o.taskId,
    subjectType: o.subjectType,
    subjectId: o.subjectId,
    payload,
  };
  store.put('operations', event);
}

/** 写一条结算事实。改判只替换事实本身，并保留首次结算时的 seq。 */
export function putSettlementEntry(store: Store, date: ISODate, item: SettleItem, outcome: Outcome, reason?: SkipReason) {
  const id = entryId(date, item.type, item.id);
  const prev = store.data.entries.find((entry) => entry.id === id);
  // Same outcome is not a no-op when a legacy entry is missing ownership:
  // itemsForDay may have recovered CHORES from the source calendar event.
  if (prev && prev.outcome === outcome && prev.reason === reason && prev.projectId === item.projectId) return;
  const projectId = item.projectId;
  const entry: SettlementEntry = {
    id,
    seq: prev?.seq ?? nextFactSeq(store.data),
    date,
    itemType: item.type,
    itemId: item.id,
    outcome,
    reason,
    projectId,
    title: item.title,
  };
  store.put('entries', entry);
}
