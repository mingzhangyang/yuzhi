export interface MigrationStep<T> {
  /** Target version. A step from v1 to v2 has to = 2. */
  to: number;
  /**
   * May mutate the cloned input in place and return void, or return a replacement.
   * The caller's input is never mutated.
   */
  run(data: T): T | void;
}

export interface MigrationResult<T> {
  data: T;
  version: number;
}

/**
 * Run contiguous data migrations on a clone of the input.
 *
 * Version numbers describe business-data semantics, not IndexedDB schema
 * versions. Missing steps are treated as a programming error so we never
 * silently reinterpret old data as a newer shape.
 */
export function runMigrationSteps<T>(
  input: T,
  fromVersion: number,
  targetVersion: number,
  steps: readonly MigrationStep<T>[],
): MigrationResult<T> {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) throw new Error('数据版本号不合法');
  if (!Number.isInteger(targetVersion) || targetVersion < 1) throw new Error('目标数据版本号不合法');
  if (fromVersion > targetVersion) throw new Error('数据来自更新的屿志版本，请先升级应用');

  const byTarget = new Map<number, MigrationStep<T>>();
  for (const step of steps) {
    if (!Number.isInteger(step.to) || step.to < 2) throw new Error('迁移步骤版本号不合法');
    if (byTarget.has(step.to)) throw new Error(`存在重复的数据迁移步骤：v${step.to}`);
    byTarget.set(step.to, step);
  }

  let data = structuredClone(input);
  let version = fromVersion;
  while (version < targetVersion) {
    const next = version + 1;
    const step = byTarget.get(next);
    if (!step) throw new Error(`缺少数据迁移步骤：v${version} → v${next}`);
    const replacement = step.run(data);
    if (replacement !== undefined) data = replacement;
    version = next;
  }
  return { data, version };
}
