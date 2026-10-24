import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { ManagedStaticProvider } from "../../../../src/dotnet/ManagedStaticProvider.js";
import { RegularFileCleanupFailure } from "../../../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(
  [false, true].flatMap((cached) =>
    ["plain", "filesystem", "cleanup"].flatMap((reasonKind) =>
      [false, true].map((denyClose) => ({ cached, denyClose, reasonKind })),
    ),
  ),
)(
  "cancels a managed source read and recovers its exact owner (cached: $cached, close denied: $denyClose, reason: $reasonKind)",
  async ({ cached, denyClose, reasonKind }) => {
    const directory = await createTestTempDirectory("rea-managed-hash-cancel-");
    const path = join(directory, "fixture.exe");
    await writeFile(
      path,
      Buffer.concat([buildManagedPeFixture(), Buffer.alloc(512 * 1024)]),
    );
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    const client = new ManagedStaticProvider().createClient(parsed.value);
    if (cached) {
      const initial = await client.execute("inspect_managed_artifact", {});
      if (!initial.ok) throw initial.error;
    }

    const admitted = await open(path, "r");
    const prototype = Object.getPrototypeOf(admitted) as FileHandle;
    await admitted.close();
    const originalRead = prototype.read;
    const controller = new AbortController();
    const reason =
      reasonKind === "cleanup"
        ? new RegularFileCleanupFailure(
            join(directory, "other-input.dll"),
            new OwnedFileHandle(admitted),
            { kind: "completed", value: null },
            new Error("opaque caller reason, not this operation's cleanup"),
          )
        : Object.assign(
            new Error("cancel after actual managed source bytes arrive"),
            reasonKind === "filesystem" ? { code: "EACCES" } : {},
          );
    let cancelledHandle: FileHandle | undefined;
    let readCount = 0;
    let permitClose = !denyClose;
    const deniedHandles: FileHandle[] = [];
    let restoreClose: (() => void) | undefined;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      readCount += 1;
      const result: Awaited<ReturnType<FileHandle["read"]>> =
        await Reflect.apply(originalRead, this, args);
      if (result.bytesRead > 0 && cancelledHandle === undefined) {
        cancelledHandle = this;
        if (denyClose) {
          const originalClose = this.close.bind(this);
          const close = vi.spyOn(this, "close").mockImplementation(async () => {
            if (!permitClose) {
              deniedHandles.push(this);
              throw new Error("fixture managed descriptor close denied");
            }
            await originalClose();
          });
          restoreClose = () => close.mockRestore();
        }
        controller.abort(reason);
      }
      return result;
    });
    try {
      const cancelled = await client.execute(
        "inspect_managed_members",
        {},
        { signal: controller.signal },
      );
      expect(cancelledHandle).toBeDefined();
      if (cancelled.ok) throw new Error("Cancelled managed hashing succeeded");
      if (denyClose) {
        expect(projectAnalysisError(cancelled.error)).toMatchObject({
          code: "cleanup_incomplete",
          details: { diagnostics: { primary_error: { code: "cancelled" } } },
        });
        expect(cancelled.error.cause).toBeInstanceOf(AggregateError);
        if (!(cancelled.error.cause instanceof AggregateError))
          throw new Error("Missing managed read and cleanup failures");
        expect(cancelled.error.cause.errors[0].cause).toBe(reason);
        expect(cancelledHandle?.fd).toBeGreaterThanOrEqual(0);
        const readsBeforeRetry = readCount;
        const blocked = await client.execute("inspect_managed_members", {});
        if (blocked.ok)
          throw new Error("Unreleased managed source admitted a read");
        expect(projectAnalysisError(blocked.error).code).toBe(
          "cleanup_incomplete",
        );
        expect(readCount).toBe(readsBeforeRetry);
        expect(deniedHandles.length).toBeGreaterThan(0);
        expect(
          deniedHandles.every((handle) => handle === cancelledHandle),
        ).toBe(true);
      } else {
        expect(projectAnalysisError(cancelled.error)).toMatchObject({
          code: "cancelled",
        });
        expect(cancelled.error.cause).toBe(reason);
        expect(cancelledHandle?.fd).toBe(-1);
      }

      permitClose = true;
      read.mockRestore();
      const recovered = await client.execute("inspect_managed_members", {});
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.subject?.sha256).toBe(parsed.value.sha256);
      expect(cancelledHandle?.fd).toBe(-1);
      expect(await client.close()).toMatchObject({ ok: true });
    } finally {
      permitClose = true;
      read.mockRestore();
      await client.close();
      restoreClose?.();
    }
  },
);

it.each([false, true])(
  "preserves an independent read failure when cancellation races with it (cached: %s)",
  async (cached) => {
    const directory = await createTestTempDirectory(
      "rea-managed-hash-read-failure-",
    );
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    const client = new ManagedStaticProvider().createClient(parsed.value);
    if (cached) {
      const initial = await client.execute("inspect_managed_artifact", {});
      if (!initial.ok) throw initial.error;
    }
    const admitted = await open(path, "r");
    const prototype = Object.getPrototypeOf(admitted) as FileHandle;
    await admitted.close();
    const originalRead = prototype.read;
    const controller = new AbortController();
    const failure = Object.assign(new Error("fixture source read failure"), {
      code: "EACCES",
    });
    let failedHandle: FileHandle | undefined;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      await Reflect.apply(originalRead, this, args);
      failedHandle = this;
      controller.abort(new Error("independent cancellation"));
      throw failure;
    });
    try {
      const result = await client.execute(
        "inspect_managed_members",
        {},
        {
          signal: controller.signal,
        },
      );
      if (result.ok) throw new Error("Failed managed hashing succeeded");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "access_denied",
      });
      expect(result.error.cause).toBe(failure);
      expect(failedHandle?.fd).toBe(-1);
    } finally {
      read.mockRestore();
      expect(await client.close()).toMatchObject({ ok: true });
    }
  },
);
