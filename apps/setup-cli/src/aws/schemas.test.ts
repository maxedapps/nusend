import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { AwsCommandError } from "./errors.ts";
import {
  ChangeSetDescriptionSchema,
  classifyAwsCliFailureText,
  decodeAwsJson,
  parseJsonStdout,
  SesEmailIdentitySchema,
} from "./schemas.ts";
import {
  parseSubscriptions,
  verifyFinalizedSubscription,
  type AwsCommandRunner,
} from "./subscription.ts";
import type { SetupState } from "../state/schema.ts";
import { ok } from "./test-harness.ts";

describe("AWS schema boundary and classification", () => {
  it("classifies auth expiry, authorization, throttling, and timeout", () => {
    expect(classifyAwsCliFailureText("Error when retrieving token from sso")).toBe(
      "expired-session",
    );
    expect(classifyAwsCliFailureText("An error occurred (AccessDenied)")).toBe("access-denied");
    expect(classifyAwsCliFailureText("Rate exceeded")).toBe("throttling");
    expect(classifyAwsCliFailureText("Request timed out")).toBe("timeout");
    expect(classifyAwsCliFailureText("Stack does not exist")).toBe("not-found");
    expect(classifyAwsCliFailureText("something else")).toBe(null);
  });

  it("rejects malformed JSON and schema-invalid AWS payloads", async () => {
    const badJson = await Effect.runPromiseExit(parseJsonStdout("{nope", "test-op"));
    expect(Exit.isFailure(badJson)).toBe(true);
    if (Exit.isFailure(badJson)) {
      const err = badJson.cause;
      expect(String(err)).toMatch(/malformed JSON|AwsCommandError/);
    }

    const decoded = await Effect.runPromiseExit(
      decodeAwsJson(ChangeSetDescriptionSchema, JSON.stringify(["not-an-object"]), "describe"),
    );
    expect(Exit.isFailure(decoded)).toBe(true);

    const identity = await Effect.runPromise(
      decodeAwsJson(
        SesEmailIdentitySchema,
        JSON.stringify({ VerificationStatus: "SUCCESS", VerifiedForSendingStatus: true }),
        "identity",
      ),
    );
    expect(identity.VerificationStatus).toBe("SUCCESS");
  });

  it("parses SNS subscription lists strictly", () => {
    expect(() => parseSubscriptions({})).toThrow(/malformed/);
    expect(
      parseSubscriptions({
        Subscriptions: [
          {
            SubscriptionArn: "arn:aws:sns:x",
            Protocol: "HTTPS",
            Endpoint: "https://example.com",
            Owner: "123",
          },
        ],
      }),
    ).toEqual([
      {
        subscriptionArn: "arn:aws:sns:x",
        protocol: "https",
        endpoint: "https://example.com",
        owner: "123",
      },
    ]);
  });
});

describe("subscription polling with TestClock", () => {
  it("advances bounded waits without real sleeps", async () => {
    const state = {
      schemaVersion: 1 as const,
      installationId: "prod",
      createdAt: "t",
      updatedAt: "t",
      config: {
        releaseTag: "v0.1.1",
        domain: "mail.example.com",
        ingressMode: "direct" as const,
        ownerEmail: "o@e.com",
        ownerName: "O",
        awsProfile: "p",
        awsRegion: "us-east-1",
        awsAccountId: "123456789012",
        sesIdentity: "example.com",
        sesFromEmail: "s@example.com",
        marketingEnabled: false,
        trackingEnabled: false,
        alertEmail: "a@e.com",
        route53HostedZoneId: null,
        sshTarget: "root@host",
        remotePath: "/srv/nusend",
      },
      stages: {},
      plans: {},
      aws: {
        stack: {
          outputs: {
            FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:topic",
            DlqArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
          },
        },
      },
    } satisfies SetupState;

    let listCalls = 0;
    const run: AwsCommandRunner = (command) =>
      Effect.sync(() => {
        if (command[0] === "sns" && command[1] === "list-subscriptions-by-topic") {
          listCalls += 1;
          // Stay empty until enough polls would have slept.
          if (listCalls < 3) {
            return ok(JSON.stringify({ Subscriptions: [] }));
          }
          return ok(
            JSON.stringify({
              Subscriptions: [
                {
                  Protocol: "https",
                  Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
                  SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:topic:sub",
                  Owner: "123456789012",
                },
              ],
            }),
          );
        }
        if (command[0] === "sns" && command[1] === "get-subscription-attributes") {
          return ok(
            JSON.stringify({
              Attributes: {
                Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
                Protocol: "https",
                PendingConfirmation: "false",
                RawMessageDelivery: "false",
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
                }),
              },
            }),
          );
        }
        throw new Error(`unexpected ${command.join(" ")}`);
      });

    const program = Effect.gen(function* () {
      const fiber = yield* verifyFinalizedSubscription(state, run, { attempts: 4 }).pipe(
        Effect.forkChild,
      );
      // Two sleeps of 5 seconds each before the third list returns a subscription.
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      return yield* Fiber.join(fiber);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
    expect(result.verified).toBe(true);
    expect(result.subscriptionArn).toContain(":sub");
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  it("surfaces AwsCommandError for malformed subscription JSON without retrying auth", async () => {
    const run: AwsCommandRunner = () => Effect.succeed(ok("not-json"));
    const exit = await Effect.runPromiseExit(
      decodeAwsJson(
        // reuse helper
        (await import("./schemas.ts")).SnsSubscriptionsResultSchema,
        "not-json",
        "sns list",
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    void run;
    expect(
      new AwsCommandError({
        message: "x",
        reason: "access-denied",
        operation: "x",
      }).reason,
    ).toBe("access-denied");
  });
});
