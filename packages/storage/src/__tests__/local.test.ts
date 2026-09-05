import { describe, expect, it } from "vitest";
import { writeFile, stat } from "node:fs/promises";
import { createLocalDriver, verifyLocalStorageToken, signLocalStorageToken, resolveLocalPath, ensureLocalDir } from "../local";

describe("local storage driver", () => {
  const driver = createLocalDriver();

  it("issues an upload URL whose token verifies, and rejects a tampered signature", async () => {
    const { uploadUrl, key } = await driver.getUploadUrl("issue-attachments/test-key.png", {
      contentType: "image/png",
    });
    const url = new URL(uploadUrl);
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature")!;

    expect(verifyLocalStorageToken({ action: "upload", key, expires, signature })).toBe(true);
    expect(verifyLocalStorageToken({ action: "upload", key, expires, signature: signature + "x" })).toBe(false);
    // A signature minted for "upload" must not verify for "download" of the same key/expiry.
    expect(verifyLocalStorageToken({ action: "download", key, expires, signature })).toBe(false);
  });

  it("rejects an otherwise-correct signature once its expiry timestamp has passed", () => {
    const key = "issue-attachments/expired.png";
    const pastExpires = Date.now() - 1000;
    // A real signature for THIS exact (action, key, expires) triple — not a
    // mismatched one — isolates the expiry check from the signature check.
    const validSignatureForPastExpiry = signLocalStorageToken("upload", key, pastExpires);
    expect(
      verifyLocalStorageToken({ action: "upload", key, expires: pastExpires, signature: validSignatureForPastExpiry }),
    ).toBe(false);
  });

  it("resolveLocalPath refuses to escape STORAGE_LOCAL_DIR via path traversal", () => {
    expect(() => resolveLocalPath("../../etc/passwd")).toThrow();
    expect(() => resolveLocalPath("issue-attachments/../../../etc/passwd")).toThrow();
    expect(() => resolveLocalPath("issue-attachments/fine.png")).not.toThrow();
  });

  it("putObject writes bytes directly to disk, readable back exactly", async () => {
    const key = "issue-attachments/put-object-test.bin";
    const bytes = Buffer.from("real file bytes, not a signed URL round-trip");
    await driver.putObject(key, bytes, { contentType: "application/octet-stream" });

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(resolveLocalPath(key));
    expect(written).toEqual(bytes);

    await driver.delete(key);
  });

  it("delete actually removes the file from disk", async () => {
    const key = "issue-attachments/delete-me.txt";
    const path = resolveLocalPath(key);
    await ensureLocalDir(path);
    await writeFile(path, "hello");
    await expect(stat(path)).resolves.toBeTruthy();

    await driver.delete(key);
    await expect(stat(path)).rejects.toThrow();
  });
});
