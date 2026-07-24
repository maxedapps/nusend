import { describe, expect, it } from "vitest";

import { redactText, runProcess } from "./process.mjs";

describe("process executor", () => {
  it("runs argv arrays and captures stdout", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello')"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("hello");
    expect(result.argv[0]).toBe(process.execPath);
  });

  it("propagates nonzero exit codes", async () => {
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
      }),
    ).rejects.toMatchObject({ exitCode: 7 });
  });

  it("allows nonzero exit when requested", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      allowNonZero: true,
    });
    expect(result.exitCode).toBe(3);
  });

  it("propagates termination signals", async () => {
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"],
      }),
    ).rejects.toMatchObject({ signal: "SIGTERM" });
  });

  it("redacts secrets from failure output and helper text", async () => {
    const secret = "super-secret-value-zz";
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", `console.error('leak ${secret}'); process.exit(1)`],
        redact: [secret],
      }),
    ).rejects.toThrow(/leak \*\*\*/);

    expect(redactText(`token=${secret}`, [secret])).toBe("token=***");
    expect(redactText("short", ["ab"])).toBe("short");
  });

  it("passes stdin without shell interpolation", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
      ],
      stdin: "line-one\n",
    });
    expect(result.stdout).toBe("line-one\n");
  });
});
