// Reads the COMPUTERD_DB environment variable and works out where the
// workspace database should live.
//
// "memory", or nothing at all, keeps the database in memory. An
// absolute path puts it on disk, where it survives a restart.

import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve as resolvePath, sep } from "node:path";

import type { SynchronousLevel } from "@cloudflare/dofs/node";

export type StoreMode = { kind: "memory" } | { kind: "file"; path: string };

export type ResolvedStore = { kind: "memory" } | { kind: "file"; path: string; fresh: boolean };

const MEMORY_VALUE = "memory";

export function parseStoreMode(value: string | undefined): StoreMode {
  if (value === undefined || value === "") return { kind: "memory" };
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === MEMORY_VALUE) return { kind: "memory" };
  // Same rule MOUNT_POINT enforces. A relative path resolves against
  // the working directory, which is not something a container author
  // should have to reason about.
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `COMPUTERD_DB must be "memory" or an absolute path, got ${JSON.stringify(value)}`,
    );
  }
  return { kind: "file", path: normalize(trimmed) };
}

export function resolveStore(mode: StoreMode, mountPoint: string): ResolvedStore {
  if (mode.kind === "memory") return { kind: "memory" };
  assertOutsideMountPoint(mode.path, mountPoint);
  return { kind: "file", path: mode.path, fresh: !existsSync(mode.path) };
}

// A store the FUSE mount also projects is a loop: writing to the
// database produces filesystem entries, which produce writes to the
// database. Cheap to check here, confusing to debug in the field.
function assertOutsideMountPoint(path: string, mountPoint: string): void {
  const mount = resolvePath(mountPoint);
  const candidate = resolvePath(path);
  // Compare against the mount plus a separator, not the bare prefix.
  // A plain startsWith would also reject /workspace-other, which is a
  // sibling and perfectly legal.
  if (candidate === mount || candidate.startsWith(`${mount}${sep}`)) {
    throw new Error(
      `COMPUTERD_DB must not sit inside the mount point (${mount}), got ${JSON.stringify(path)}`,
    );
  }
}

const SYNCHRONOUS_LEVELS: readonly SynchronousLevel[] = ["off", "normal", "full"];

// Reads COMPUTERD_DB_SYNCHRONOUS, SQLite's synchronous level for a file
// store. Unset keeps the default, normal. "off" skips the disk syncs
// SQLite makes each time it folds its log back into the database, which
// is most of the cost of saving a small file. Only a crash of the whole
// machine can then corrupt the store, which costs nothing on a host
// whose disk does not outlive the machine.
export function parseStoreSynchronous(value: string | undefined): SynchronousLevel | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return undefined;
  if ((SYNCHRONOUS_LEVELS as readonly string[]).includes(trimmed)) {
    return trimmed as SynchronousLevel;
  }
  throw new Error(
    `COMPUTERD_DB_SYNCHRONOUS must be one of ${SYNCHRONOUS_LEVELS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}
