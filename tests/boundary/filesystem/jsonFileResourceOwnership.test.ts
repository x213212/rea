import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { readJsonFile } from "../../../src/application/JsonFiles.js";
import {
  readJsonInputFile,
  readJsonObjectFile,
} from "../../../src/application/JsonInputFile.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["native-read", "streamed-read", "members"] as const)(
  "does not adopt a caller's cleanup owner when JSON cancellation arrives during %s",
  async (stage) => {
    const root = await createTestTempDirectory("rea-json-caller-owner-");
    const path = join(root, "input.json");
    await writeFile(
      path,
      `${stage === "streamed-read" ? " ".repeat(9 * 1024 * 1024) : ""}{"items":[1,2]}`,
    );
    const callerOwner = new OwnedFileHandle(await open(path, "r"));
    const reason = new RegularFileCleanupFailure(
      path,
      callerOwner,
      { kind: "completed", value: null },
      new Error("opaque caller cleanup reason"),
    );
    const controller = new AbortController();
    const resources = new ArtifactResourceScope();
    const prototype = Object.getPrototypeOf(callerOwner.handle) as FileHandle;
    const originalRead = prototype.read;
    let admitted: FileHandle | undefined;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      const result: Awaited<ReturnType<FileHandle["read"]>> =
        await Reflect.apply(originalRead, this, args);
      admitted = this;
      if (stage !== "members" && result.bytesRead > 0) controller.abort(reason);
      return result;
    });
    const accepted: unknown[] = [];
    try {
      const failure: unknown = await (
        stage === "members"
          ? readJsonObjectFile(
              path,
              "test-input",
              [
                new Map([
                  [
                    "items",
                    {
                      mode: "array" as const,
                      begin: () => {},
                      accept: (value: unknown) => {
                        accepted.push(value);
                        controller.abort(reason);
                      },
                      reject: (cause: unknown) => {
                        throw cause;
                      },
                    },
                  ],
                ]),
              ],
              controller.signal,
              resources,
            )
          : readJsonInputFile(path, "test-input", controller.signal, resources)
      ).catch((cause: unknown) => cause);
      expect(failure).toBe(reason);
      if (stage === "members") expect(accepted).toEqual([1]);
      expect(admitted?.fd).toBe(-1);
      expect(callerOwner.handle.fd).toBeGreaterThanOrEqual(0);
      expect(resources.hasPending).toBe(false);
    } finally {
      read.mockRestore();
      await resources.close();
      await callerOwner.close();
    }
  },
);

it("retains and retries a JSON file owner after a persistent close failure", async () => {
  const root = await createTestTempDirectory("rea-json-file-owner-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":"retained"}');
  const resources = new ArtifactResourceScope();
  const closeFailure = new Error("injected persistent close failure");
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async () => {
      attempts += 1;
      throw closeFailure;
    });
  let failure: unknown;
  try {
    try {
      await readJsonFile(path, undefined, resources);
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected the failed file owner to remain visible");
    expect(failure.cleanupCause).toBe(closeFailure);
    expect(failure.outcome).toMatchObject({
      kind: "completed",
      value: { ok: true, value: { value: "retained" } },
    });
    expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resources.close();
  }
  if (!(failure instanceof RegularFileCleanupFailure))
    throw new Error("Expected the retained file owner");
  expect(failure.owner.handle.fd).toBe(-1);
});

it("returns parsed JSON when a failed file close is recovered by the resource scope", async () => {
  const root = await createTestTempDirectory("rea-json-file-close-retry-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":"retained"}');
  const resources = new ArtifactResourceScope();
  const closeFailure = new Error("injected transient close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      attempts += 1;
      if (attempts === 1) throw closeFailure;
      await originalClose.call(this);
    });
  try {
    const parsed = await readJsonFile(path, undefined, resources);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toEqual({ value: "retained" });
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resources.close();
  }
});
