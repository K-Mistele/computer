// Decides which paths the container keeps to itself: anything a git
// repo in the workspace ignores, such as node_modules or build output.
// The sync server leaves those paths out when the durable object pulls
// changes, so a dependency install never floods its storage.
//
// The workspace can hold one repo at its root or several in
// subfolders. Each path follows the rules of the repo it sits in, read
// from that repo's .gitignore files and .git/info/exclude the way git
// reads them. A path outside every repo is never ignored.
//
// A pull can carry tens of thousands of paths under one ignored
// folder, so answers are remembered per folder: once node_modules is
// known to be ignored, every path under it is decided by a few map
// lookups without touching the store. `refresh` drops what is
// remembered when the rules themselves may have changed.

import { type Database, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import ignore, { type Ignore } from "ignore";

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

// `path` relative to `dir`, which contains it.
function relativeTo(dir: string, path: string): string {
  return dir === "/" ? path.slice(1) : path.slice(dir.length + 1);
}

function isInside(dir: string, path: string): boolean {
  return dir === "/" || path === dir || path.startsWith(`${dir}/`);
}

export class GitignoreFilter {
  readonly #db: Database;
  readonly #fs: SQLiteWorkspaceProvider;
  // Folder -> the root of the repo it sits in, or null outside any repo.
  readonly #repoRoots = new Map<string, string | null>();
  // Folder -> the rules its .gitignore holds, or null when it has none.
  // A repo root's entry also holds .git/info/exclude, under its own.
  readonly #rules = new Map<string, Ignore[] | null>();
  // Folder -> whether the folder itself is ignored.
  readonly #ignoredFolders = new Map<string, boolean>();
  #rulesVersion: string | undefined;

  constructor(db: Database) {
    this.#db = db;
    this.#fs = new SQLiteWorkspaceProvider(db);
  }

  // Forget everything remembered if any .gitignore, .git or exclude
  // file has been added, changed or removed since the last call. Cheap
  // enough to run before every pull.
  refresh(): void {
    const row = this.#db.one<{ rev: number | null; count: number }>(
      `SELECT MAX(n.rev) AS rev, COUNT(*) AS count
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.name IN ('.gitignore', '.git', 'exclude')`,
    );
    const version = `${row?.rev ?? 0}:${row?.count ?? 0}`;
    if (version === this.#rulesVersion) return;
    this.#rulesVersion = version;
    this.#repoRoots.clear();
    this.#rules.clear();
    this.#ignoredFolders.clear();
  }

  isIgnored(path: string): boolean {
    if (path === "/") return false;
    const parent = parentOf(path);
    if (this.#isIgnoredFolder(parent)) return true;
    const root = this.#repoRootOf(parent);
    if (root === null || path === root || this.#isInGitFolder(root, path)) return false;
    return this.#matches(root, path, this.#isDirectory(path));
  }

  #isIgnoredFolder(dir: string): boolean {
    const known = this.#ignoredFolders.get(dir);
    if (known !== undefined) return known;
    let ignored = false;
    if (dir !== "/") {
      if (this.#isIgnoredFolder(parentOf(dir))) {
        ignored = true;
      } else {
        const root = this.#repoRootOf(dir);
        ignored =
          root !== null &&
          dir !== root &&
          !this.#isInGitFolder(root, dir) &&
          this.#matches(root, dir, true);
      }
    }
    this.#ignoredFolders.set(dir, ignored);
    return ignored;
  }

  #repoRootOf(dir: string): string | null {
    const known = this.#repoRoots.get(dir);
    if (known !== undefined) return known;
    const root = this.#fs.existsSync(join(dir, ".git"))
      ? dir
      : dir === "/"
        ? null
        : this.#repoRootOf(parentOf(dir));
    this.#repoRoots.set(dir, root);
    return root;
  }

  #isInGitFolder(root: string, path: string): boolean {
    return isInside(join(root, ".git"), path);
  }

  // Apply the rules from the repo root down to the path's folder. The
  // last rule that matches decides, so a deeper .gitignore overrides a
  // higher one. Callers have already checked that no folder above the
  // path is ignored, which git requires before a file can be re-included.
  #matches(root: string, path: string, isDirectory: boolean): boolean {
    const folders: string[] = [];
    for (let dir = parentOf(path); ; dir = parentOf(dir)) {
      folders.push(dir);
      if (dir === root) break;
    }
    let ignored = false;
    for (const dir of folders.reverse()) {
      const rules = this.#rulesIn(root, dir);
      if (rules === null) continue;
      const relative = relativeTo(dir, path) + (isDirectory ? "/" : "");
      for (const rule of rules) {
        const result = rule.test(relative);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
    }
    return ignored;
  }

  #rulesIn(root: string, dir: string): Ignore[] | null {
    const known = this.#rules.get(dir);
    if (known !== undefined) return known;
    const files =
      dir === root
        ? [join(root, ".git/info/exclude"), join(dir, ".gitignore")]
        : [join(dir, ".gitignore")];
    const rules = files.flatMap((file) => {
      const text = this.#readText(file);
      return text === null ? [] : [ignore().add(text)];
    });
    const result = rules.length === 0 ? null : rules;
    this.#rules.set(dir, result);
    return result;
  }

  #readText(path: string): string | null {
    try {
      const content = this.#fs.readFileSync(path, "utf8");
      return typeof content === "string" ? content : content.toString("utf8");
    } catch {
      return null;
    }
  }

  #isDirectory(path: string): boolean {
    try {
      return this.#fs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
