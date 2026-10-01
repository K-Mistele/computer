// Tracks how long the kernel may still hold answers the FUSE driver gave.
//
// The kernel caches lookups ("exists", "not found") and attributes for
// the entry, attr and negative timeouts. Writes through the mount keep
// that cache right, but a push from the durable object writes the store
// directly, behind the kernel's back. A command that starts right after
// such a push could then see a cached answer from before it: a file the
// host just wrote still "not found", or an old size.
//
// The clock stamps every answer that can land in the kernel's cache, and
// settle() waits until the newest of them has expired. Called after a
// push, before the command runs, it costs nothing unless the mount
// answered a lookup within the last timeout.

// Lookups and attributes both come back through these ops.
const CACHED_ANSWER_OPS = new Set(["getattr", "fgetattr"]);

// The kernel starts a timeout when it reads the reply, a moment after
// the driver answers. Wait this much longer to cover the gap.
const SETTLE_MARGIN_MILLIS = 50;

export interface KernelCacheClock {
  /** Wrap a FUSE ops object so answers that the kernel may cache are stamped. */
  wrap<T extends Record<string, unknown>>(ops: T): T;
  /** Milliseconds until every stamped answer has expired from the kernel. */
  remainingMillis(): number;
  /** Resolve once remainingMillis() reaches zero. */
  settle(): Promise<void>;
}

export function createKernelCacheClock(
  cacheMillis: number,
  now: () => number = Date.now,
): KernelCacheClock {
  let lastAnswerAt = Number.NEGATIVE_INFINITY;

  const remainingMillis = (): number =>
    cacheMillis <= 0 ? 0 : Math.max(0, lastAnswerAt + cacheMillis + SETTLE_MARGIN_MILLIS - now());

  return {
    wrap(ops) {
      const out: Record<string, unknown> = { ...ops };
      for (const name of CACHED_ANSWER_OPS) {
        const op = ops[name];
        if (typeof op !== "function") continue;
        out[name] = (...args: unknown[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === "function") {
            args[args.length - 1] = (...result: unknown[]) => {
              lastAnswerAt = now();
              (cb as (...r: unknown[]) => void)(...result);
            };
          }
          return (op as (...a: unknown[]) => unknown).apply(ops, args);
        };
      }
      return out as typeof ops;
    },
    remainingMillis,
    settle() {
      const remaining = remainingMillis();
      if (remaining === 0) return Promise.resolve();
      return new Promise((resolve) => setTimeout(resolve, remaining));
    },
  };
}
