import { describe, expect, it } from "vitest";

import { loadJsonInput } from "./json-input.js";

describe("loadJsonInput", () => {
  it("loads object JSON from a path through the injectable reader", async () => {
    await expect(
      loadJsonInput(
        { kind: "path", path: "/tmp/body.json" },
        {
          readTextFile: async (path) => {
            expect(path).toBe("/tmp/body.json");
            return '{"hello":"world"}';
          },
        },
      ),
    ).resolves.toEqual({ hello: "world" });
  });

  it("loads JSON from injectable stdin", async () => {
    await expect(
      loadJsonInput(
        { kind: "stdin" },
        {
          readStdin: async () => '[{"email":"a@example.com"}]',
        },
      ),
    ).resolves.toEqual([{ email: "a@example.com" }]);
  });

  it("reports empty path and stdin input", async () => {
    await expect(
      loadJsonInput({ kind: "path", path: "empty.json" }, { readTextFile: async () => "   \n" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "JSON file is empty: empty.json",
    });

    await expect(
      loadJsonInput({ kind: "stdin" }, { readStdin: async () => "" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "JSON input from stdin is empty.",
    });
  });

  it("reports malformed path and stdin input", async () => {
    await expect(
      loadJsonInput({ kind: "path", path: "bad.json" }, { readTextFile: async () => "{not-json" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "JSON file is malformed: bad.json",
    });

    await expect(
      loadJsonInput({ kind: "stdin" }, { readStdin: async () => "{" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "JSON input from stdin is malformed.",
    });
  });

  it("reports unreadable files with the underlying detail", async () => {
    await expect(
      loadJsonInput(
        { kind: "path", path: "missing.json" },
        {
          readTextFile: async () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "Unable to read JSON file missing.json: ENOENT",
    });
  });
});
