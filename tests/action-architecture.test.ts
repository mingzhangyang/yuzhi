import { describe, expect, it } from 'vitest';
import barrel from '../src/actions.ts?raw';
import calendarSource from '../src/actions/calendar.ts?raw';
import completionSource from '../src/actions/completion.ts?raw';
import projectsSource from '../src/actions/projects.ts?raw';
import settlementSource from '../src/actions/settlement.ts?raw';
import sharedSource from '../src/actions/shared.ts?raw';
import tasksSource from '../src/actions/tasks.ts?raw';

const domainSources = [
  calendarSource,
  completionSource,
  projectsSource,
  settlementSource,
  sharedSource,
  tasksSource,
];

describe('action architecture boundaries', () => {
  it('domain modules never depend on the public action barrel', () => {
    for (const source of domainSources) {
      expect(source).not.toMatch(/from\s+['"]\.\.\/actions['"]/);
    }
  });

  it('the public action module stays a composition-only barrel', () => {
    expect(barrel).not.toContain('store.batch(');
    expect(barrel).not.toMatch(/function\s+\w+Impl\b/);
  });
});
