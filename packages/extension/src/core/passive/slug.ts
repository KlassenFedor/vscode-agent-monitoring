/**
 * Directory name Claude Code derives from a working directory.
 *
 * `/home/user_f/projects/x` becomes `-home-user-f-projects-x`: every character that
 * is not a letter or a digit turns into a dash, including the underscore in a user
 * name and the dot in a directory like `my.project`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
