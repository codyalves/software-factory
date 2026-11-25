import { describe, expect, it } from 'vitest';
import { pickProject, projectList, projectName } from './projects';

describe('projects', () => {
  it('reads a comma or space separated list, dropping repeats and invalid names', () => {
    expect(
      projectList('codyalves/brewery, codyalves/factory-target-app codyalves/brewery ../etc nope'),
    ).toEqual(['codyalves/brewery', 'codyalves/factory-target-app']);
  });

  it('keeps the picked project only while it is configured', () => {
    const projects = ['codyalves/brewery', 'codyalves/factory-target-app'];

    expect(pickProject(projects, 'codyalves/factory-target-app')).toBe('codyalves/factory-target-app');
    expect(pickProject(projects, 'someone/else')).toBe('codyalves/brewery');
    expect(pickProject(projects, undefined)).toBe('codyalves/brewery');
  });

  it('names a project by its repository', () => {
    expect(projectName('codyalves/brewery')).toBe('brewery');
  });
});
