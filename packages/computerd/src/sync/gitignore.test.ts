import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { GitignoreFilter } from "./gitignore.js";

// A store with the given files. Directories are created as needed; a
// path ending in "/" is an empty directory.
function storeWith(files: Record<string, string>) {
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, () => 1000);
  const fs = new SQLiteWorkspaceProvider(db);
  for (const [path, content] of Object.entries(files)) {
    const dir = path.endsWith("/") ? path.slice(0, -1) : path.slice(0, path.lastIndexOf("/"));
    if (dir !== "") fs.mkdirSync(dir, { recursive: true });
    if (!path.endsWith("/")) fs.writeFileSync(path, content);
  }
  return { db, fs, filter: new GitignoreFilter(db) };
}

describe("GitignoreFilter", () => {
  it("ignores what a repo's .gitignore lists, files and folders", () => {
    const { filter } = storeWith({
      "/workspace/app/.git/": "",
      "/workspace/app/.gitignore": "node_modules/\n*.log\ndist\n",
      "/workspace/app/src/index.ts": "",
      "/workspace/app/node_modules/react/index.js": "",
      "/workspace/app/debug.log": "",
      "/workspace/app/dist/out.js": "",
    });

    expect(filter.isIgnored("/workspace/app/src/index.ts")).toBe(false);
    expect(filter.isIgnored("/workspace/app/src")).toBe(false);
    expect(filter.isIgnored("/workspace/app/node_modules")).toBe(true);
    expect(filter.isIgnored("/workspace/app/node_modules/react/index.js")).toBe(true);
    expect(filter.isIgnored("/workspace/app/debug.log")).toBe(true);
    expect(filter.isIgnored("/workspace/app/dist/out.js")).toBe(true);
    expect(filter.isIgnored("/workspace/app/.gitignore")).toBe(false);
  });

  it("only matches a trailing-slash pattern against folders", () => {
    const { filter } = storeWith({
      "/repo/.git/": "",
      "/repo/.gitignore": "build/\n",
      "/repo/build": "a file named build",
      "/repo/sub/build/x.o": "",
    });

    expect(filter.isIgnored("/repo/build")).toBe(false);
    expect(filter.isIgnored("/repo/sub/build/x.o")).toBe(true);
  });

  it("applies nested .gitignore files relative to their folder, deeper rules winning", () => {
    const { filter } = storeWith({
      "/repo/.git/": "",
      "/repo/.gitignore": "*.json\n",
      "/repo/packages/core/.gitignore": "!keep.json\n/local.txt\n",
      "/repo/packages/core/keep.json": "",
      "/repo/packages/core/other.json": "",
      "/repo/packages/core/local.txt": "",
      "/repo/packages/core/deep/local.txt": "",
    });

    expect(filter.isIgnored("/repo/packages/core/keep.json")).toBe(false);
    expect(filter.isIgnored("/repo/packages/core/other.json")).toBe(true);
    expect(filter.isIgnored("/repo/packages/core/local.txt")).toBe(true);
    expect(filter.isIgnored("/repo/packages/core/deep/local.txt")).toBe(false);
  });

  it("cannot re-include a file inside an ignored folder, as in git", () => {
    const { filter } = storeWith({
      "/repo/.git/": "",
      "/repo/.gitignore": "dist/\n!dist/keep.js\n",
      "/repo/dist/keep.js": "",
    });

    expect(filter.isIgnored("/repo/dist/keep.js")).toBe(true);
  });

  it("reads .git/info/exclude", () => {
    const { filter } = storeWith({
      "/repo/.git/info/exclude": "scratch/\n",
      "/repo/scratch/notes.md": "",
    });

    expect(filter.isIgnored("/repo/scratch/notes.md")).toBe(true);
  });

  it("keeps each repo's rules to itself and ignores nothing outside a repo", () => {
    const { filter } = storeWith({
      "/workspace/a/.git/": "",
      "/workspace/a/.gitignore": "out/\n",
      "/workspace/b/.git/": "",
      "/workspace/b/out/x": "",
      "/workspace/a/out/x": "",
      "/workspace/.gitignore": "*\n",
      "/workspace/loose.txt": "",
    });

    expect(filter.isIgnored("/workspace/a/out/x")).toBe(true);
    expect(filter.isIgnored("/workspace/b/out/x")).toBe(false);
    expect(filter.isIgnored("/workspace/loose.txt")).toBe(false);
  });

  it("never ignores the .git folder itself", () => {
    const { filter } = storeWith({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.gitignore": "*\n",
    });

    expect(filter.isIgnored("/repo/.git")).toBe(false);
    expect(filter.isIgnored("/repo/.git/HEAD")).toBe(false);
  });

  it("works for a repo at the root of the store", () => {
    const { filter } = storeWith({
      "/.git/": "",
      "/.gitignore": "node_modules/\n",
      "/node_modules/x.js": "",
      "/index.ts": "",
    });

    expect(filter.isIgnored("/node_modules/x.js")).toBe(true);
    expect(filter.isIgnored("/index.ts")).toBe(false);
  });

  it("picks up a changed .gitignore once refreshed", () => {
    const { fs, filter } = storeWith({
      "/repo/.git/": "",
      "/repo/.gitignore": "",
      "/repo/tmp/x": "",
    });
    expect(filter.isIgnored("/repo/tmp/x")).toBe(false);

    // Remembered until the rules change.
    fs.writeFileSync("/repo/.gitignore", "tmp/\n");
    filter.refresh();
    expect(filter.isIgnored("/repo/tmp/x")).toBe(true);

    fs.unlinkSync("/repo/.gitignore");
    filter.refresh();
    expect(filter.isIgnored("/repo/tmp/x")).toBe(false);
  });

  it("decides files under an ignored folder without reading the store", () => {
    const { db, filter } = storeWith({
      "/repo/.git/": "",
      "/repo/.gitignore": "node_modules/\n",
      "/repo/node_modules/a/1.js": "",
    });
    expect(filter.isIgnored("/repo/node_modules/a/1.js")).toBe(true);

    let reads = 0;
    for (const method of ["all", "one", "scalar"] as const) {
      const original = db[method].bind(db) as (...args: unknown[]) => unknown;
      Object.assign(db, {
        [method]: (...args: unknown[]) => {
          reads += 1;
          return original(...args);
        },
      });
    }
    for (let i = 0; i < 1000; i++) filter.isIgnored(`/repo/node_modules/a/${i}.js`);
    expect(reads).toBe(0);
  });
});
