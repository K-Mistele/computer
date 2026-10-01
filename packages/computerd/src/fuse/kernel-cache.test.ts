import { afterEach, describe, expect, test, vi } from "vitest";

import { createKernelCacheClock } from "./kernel-cache.js";

type Callback = (...result: unknown[]) => void;

// A fake ops object: each op answers at once with errno 0.
function fakeOps() {
  return {
    getattr: (_path: string, cb: Callback) => cb(0, {}),
    fgetattr: (_path: string, _fh: number, cb: Callback) => cb(0, {}),
    read: (_path: string, cb: Callback) => cb(0),
    statfs: { notAnOp: true },
  };
}

describe("createKernelCacheClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("has nothing to wait for before any answer", () => {
    const clock = createKernelCacheClock(1000, () => 0);
    expect(clock.remainingMillis()).toBe(0);
  });

  test("counts from the last lookup or attribute answer", () => {
    let now = 10_000;
    const clock = createKernelCacheClock(1000, () => now);
    const ops = clock.wrap(fakeOps());

    ops.getattr("/a", () => {});
    now += 400;
    expect(clock.remainingMillis()).toBe(650);

    ops.fgetattr("/a", 1, () => {});
    expect(clock.remainingMillis()).toBe(1050);

    now += 1050;
    expect(clock.remainingMillis()).toBe(0);
  });

  test("ignores answers the kernel does not cache", () => {
    const clock = createKernelCacheClock(1000, () => 5000);
    const ops = clock.wrap(fakeOps());

    ops.read("/a", () => {});

    expect(clock.remainingMillis()).toBe(0);
  });

  test("passes the result through unchanged", () => {
    const clock = createKernelCacheClock(1000, () => 0);
    const ops = clock.wrap(fakeOps());
    const seen: unknown[][] = [];

    ops.getattr("/a", (...result) => seen.push(result));

    expect(seen).toEqual([[0, {}]]);
    expect(ops.statfs).toEqual({ notAnOp: true });
  });

  test("never waits when the kernel caches nothing", () => {
    const clock = createKernelCacheClock(0, () => 0);
    const ops = clock.wrap(fakeOps());

    ops.getattr("/a", () => {});

    expect(clock.remainingMillis()).toBe(0);
  });

  test("settle resolves once the cache has expired", async () => {
    vi.useFakeTimers({ now: 20_000 });
    const clock = createKernelCacheClock(1000);
    const ops = clock.wrap(fakeOps());
    ops.getattr("/a", () => {});

    let settled = false;
    const done = clock.settle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(settled).toBe(true);
  });
});
