// Query-plan checks for the path walk. EXPLAIN QUERY PLAN runs against
// node:sqlite only, so the workers config excludes this file.

import { describe, expect, it } from "vitest";

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import { RESOLVE_PATH_SQL } from "./resolve.js";

describe("RESOLVE_PATH_SQL", () => {
  it("finds each segment by parent and name, not by scanning the directory", () => {
    const storage = new SQLiteTestStorage();
    try {
      const db = new Database(storage);
      initializeSchema(db, () => 0);
      const plan = db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${RESOLVE_PATH_SQL}`,
          JSON.stringify(["a", "b"]),
          1,
        )
        .map((row) => row.detail);

      expect(plan).toContain("SEARCH d USING PRIMARY KEY (parent_inode=? AND name=?)");
    } finally {
      storage.close();
    }
  });
});
