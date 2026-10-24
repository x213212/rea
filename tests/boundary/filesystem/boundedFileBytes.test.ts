import { appendFile, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RegularFileOperationCancelled } from "../../../src/filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../../../src/process/BoundedFileBytes.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("bounded file byte reads", () => {
  it.each([undefined, 8])(
    "marks checkpoint cancellation without closing the caller's handle (expected size: %s)",
    async (expectedSize) => {
      const root = await createTestTempDirectory("rea-bounded-cancel-");
      const path = join(root, "input");
      await writeFile(path, "contents");
      const handle = await open(path, "r");
      const controller = new AbortController();
      const reason = new Error("caller stopped the bounded read");
      controller.abort(reason);
      try {
        const failure = await readBoundedFileBytes(
          handle,
          8,
          controller.signal,
          expectedSize,
        ).catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(RegularFileOperationCancelled);
        if (!(failure instanceof RegularFileOperationCancelled)) throw failure;
        expect(failure.reason).toBe(reason);
        expect(handle.fd).toBeGreaterThanOrEqual(0);
      } finally {
        await handle.close();
      }
    },
  );

  it.each([undefined, 8])(
    "preserves an independent I/O failure racing with cancellation (expected size: %s)",
    async (expectedSize) => {
      const root = await createTestTempDirectory("rea-bounded-read-failure-");
      const path = join(root, "input");
      await writeFile(path, "contents");
      const handle = await open(path, "r");
      const controller = new AbortController();
      const failure = Object.assign(new Error("file read failed"), {
        code: "EIO",
      });
      const read = vi.spyOn(handle, "read").mockImplementationOnce(async () => {
        controller.abort(new Error("independent cancellation"));
        throw failure;
      });
      try {
        await expect(
          readBoundedFileBytes(handle, 8, controller.signal, expectedSize),
        ).rejects.toBe(failure);
        expect(handle.fd).toBeGreaterThanOrEqual(0);
      } finally {
        read.mockRestore();
        await handle.close();
      }
    },
  );

  it.each([0, 65_536])(
    "accepts a file exactly at the %i byte limit",
    async (limit) => {
      const root = await createTestTempDirectory("rea-bounded-bytes-");
      const path = join(root, "input");
      const content = Buffer.alloc(limit, 0x61);
      await writeFile(path, content);
      const handle = await open(path, "r");
      try {
        expect(await readBoundedFileBytes(handle, limit)).toEqual(content);
      } finally {
        await handle.close();
      }
    },
  );

  it("stops after one overflow byte when a file grows beyond its admitted size", async () => {
    const root = await createTestTempDirectory("rea-growing-bytes-");
    const path = join(root, "input");
    await writeFile(path, "0123456789");
    const handle = await open(path, "r");
    try {
      expect((await handle.stat()).size).toBeLessThan(12);
      await appendFile(path, "abcdefghijklmnopqrstuvwxyz");
      expect(await readBoundedFileBytes(handle, 12)).toBeUndefined();
      const next = Buffer.alloc(1);
      expect((await handle.read(next, 0, 1, null)).bytesRead).toBe(1);
      expect(next.toString()).toBe("d");
    } finally {
      await handle.close();
    }
  });
});
