import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { TerminalFake } from "../terminal.ts";
import {
  askBoolean,
  askChoice,
  askUntil,
  looksLikeEmail,
  looksLikeHostname,
} from "./prompts.ts";

describe("prompt recovery helpers", () => {
  it("re-prompts until a non-empty valid value is entered", async () => {
    const terminal = TerminalFake({ answers: ["", "not-an-email", "ok@example.com"] });
    const value = await Effect.runPromise(
      askUntil("Email: ", {
        emptyHint: "Email is required.",
        validate: (v) => (looksLikeEmail(v) ? null : "Need a real email."),
      }).pipe(Effect.provide(terminal.layer)),
    );
    expect(value).toBe("ok@example.com");
    expect(terminal.state.stdout.join("")).toMatch(/Email is required/);
    expect(terminal.state.stdout.join("")).toMatch(/Need a real email/);
  });

  it("re-prompts invalid choices without failing the wizard", async () => {
    const terminal = TerminalFake({ answers: ["", "nope", "direct"] });
    const value = await Effect.runPromise(
      askChoice("Mode", ["direct", "cloudflare"]).pipe(Effect.provide(terminal.layer)),
    );
    expect(value).toBe("direct");
    expect(terminal.state.stdout.join("")).toMatch(/Choose one of/);
    expect(terminal.state.stdout.join("")).toMatch(/not valid/);
  });

  it("re-prompts invalid booleans", async () => {
    const terminal = TerminalFake({ answers: ["maybe", "y"] });
    const value = await Effect.runPromise(
      askBoolean("Continue?", false).pipe(Effect.provide(terminal.layer)),
    );
    expect(value).toBe(true);
    expect(terminal.state.stdout.join("")).toMatch(/y or n/);
  });

  it("validates hostname shape", () => {
    expect(looksLikeHostname("mail.example.com")).toBe(true);
    expect(looksLikeHostname("https://mail.example.com")).toBe(false);
    expect(looksLikeHostname("mail.example.com/path")).toBe(false);
  });
});
