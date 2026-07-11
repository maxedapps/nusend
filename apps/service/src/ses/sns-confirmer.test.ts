import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SnsSubscriptionConfirmer } from "./sns-confirmer.ts";
import { FakeSnsSubscriptionConfirmerLive, validateSnsSubscribeUrl } from "./sns-confirmer.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const validUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription";

describe("SnsSubscriptionConfirmer", () => {
  it("rejects non-HTTPS, non-SNS, and region-mismatched SubscribeURLs", async () => {
    await expect(
      Effect.runPromise(validateSnsSubscribeUrl("http://sns.us-east-1.amazonaws.com/", topicArn)),
    ).rejects.toMatchObject({
      _tag: "SnsConfirmationError",
    });
    await expect(
      Effect.runPromise(validateSnsSubscribeUrl("https://example.com/", topicArn)),
    ).rejects.toMatchObject({
      _tag: "SnsConfirmationError",
    });
    await expect(
      Effect.runPromise(validateSnsSubscribeUrl("https://sns.us-west-2.amazonaws.com/", topicArn)),
    ).rejects.toMatchObject({
      _tag: "SnsConfirmationError",
    });
  });

  it("rejects SubscribeURLs with credentials, non-default ports, fragments, or wrong action", async () => {
    const rejected = [
      "https://user:pass@sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
      "https://sns.us-east-1.amazonaws.com:8443/?Action=ConfirmSubscription",
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription#frag",
      "https://sns.us-east-1.amazonaws.com/other?Action=ConfirmSubscription",
      "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe",
    ];
    for (const url of rejected) {
      await expect(Effect.runPromise(validateSnsSubscribeUrl(url, topicArn))).rejects.toMatchObject(
        { _tag: "SnsConfirmationError" },
      );
    }
  });

  it("accepts a realistic SubscribeURL with the mandatory query", async () => {
    await Effect.runPromise(
      validateSnsSubscribeUrl(
        "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-east-1:123456789012:nusend-test&Token=abc123",
        topicArn,
      ),
    );
  });

  it("accepts SNS HTTPS SubscribeURLs and fake confirmer records calls", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      Effect.flatMap(SnsSubscriptionConfirmer, (confirmer) =>
        confirmer.confirm({ subscribeUrl: validUrl, topicArn }),
      ).pipe(Effect.provide(FakeSnsSubscriptionConfirmerLive(calls))),
    );

    expect(calls).toEqual([validUrl]);
  });
});
