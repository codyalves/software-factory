'use client';

import { usePathname } from 'next/navigation';
import { setProjectAction } from '@/app/actions';
import { projectName } from '@/lib/projects';

/**
 * Which site the dashboard is showing, and the way to change it. Always in
 * the rail, so the current project is never a guess; switching keeps you on
 * the page you were reading. A run's own record belongs to one project, so
 * from there a switch goes to the list of runs instead.
 */
export function ProjectSwitcher({ projects, current }: { projects: readonly string[]; current: string }) {
  const path = usePathname();
  const back = /^\/runs\/./.test(path) ? '/runs' : path;
  if (projects.length < 2) {
    return (
      <div className="rail-projects">
        <span className="rail-projects-label">Project</span>
        <span className="rail-project-only" title={current}>
          {projectName(current)}
        </span>
      </div>
    );
  }
  return (
    <form action={setProjectAction} className="rail-projects" aria-label="Project">
      <input type="hidden" name="back" value={back} />
      <span className="rail-projects-label">Project</span>
      {projects.map((p) => (
        <button key={p} type="submit" name="project" value={p} aria-pressed={p === current} title={p}>
          {projectName(p)}
        </button>
      ))}
    </form>
  );
}
