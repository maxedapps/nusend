// Shared SNS topic ARN parsing used by both signature verification and
// subscription confirmation, so the two cannot drift.
export type ParsedSnsTopicArn = {
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
};

// The topic-name charset intentionally excludes ".": a "." only appears in FIFO
// topic names (`.fifo`), and FIFO topics cannot have HTTP(S) subscriptions, so
// the stricter charset is safe — do not "fix" it back to include a dot.
export function parseSnsTopicArn(topicArn: string): ParsedSnsTopicArn | null {
  const match = /^arn:(aws|aws-us-gov|aws-cn):sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(
    topicArn,
  );
  if (!match) return null;

  return { partition: match[1] as ParsedSnsTopicArn["partition"], region: match[2] };
}

export function snsHostForTopic(topic: ParsedSnsTopicArn): string {
  const suffix = topic.partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `sns.${topic.region}.${suffix}`;
}
