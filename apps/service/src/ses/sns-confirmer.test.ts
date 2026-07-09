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
