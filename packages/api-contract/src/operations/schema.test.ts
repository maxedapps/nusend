import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DeliveriesListResponseSchema,
  DeliveryDetailResponseSchema,
  OperationsSummaryResponseSchema,
  type DeliveryDetailResponse,
} from "./schema.js";

const summary = {
  deliveries: { ambiguous: 0, failed: 0, queued: 1, sending: 0, sent: 1, suppressed: 0 },
  jobs: { dead: 0, leased: 0, queued: 1, succeeded: 1 },
  recentIssues: [
    {
      id: "delivery_2",
      kind: "delivery",
      message: null,
      relatedId: "mailing_1",
      status: "ambiguous",
      updatedAt: "2026-07-03T12:00:00.000Z",
    },
  ],
  sendAttempts: { ambiguous: 0, failed: 0, started: 0, succeeded: 1 },
};

const delivery = {
  contactId: null,
  createdAt: "2026-07-03T12:00:00.000Z",
  email: "user@example.com",
  id: "delivery_1",
  lastError: null,
  mailingId: "mailing_1",
  sesMessageId: "ses_1",
  status: "sent",
  updatedAt: "2026-07-03T12:01:00.000Z",
};

describe("operations wire schemas", () => {
  it("decodes zero-filled summary groups and nullable issue fields", () => {
    expect(Schema.decodeUnknownSync(OperationsSummaryResponseSchema)(summary)).toEqual(summary);
  });

  it("distinguishes list job/attempt context from absent context", () => {
    const response = {
      items: [
        {
          createdAt: delivery.createdAt,
          email: delivery.email,
          id: delivery.id,
          job: null,
          lastError: null,
          latestAttempt: null,
          mailingId: delivery.mailingId,
          mailingPurpose: "transactional",
          sesMessageId: delivery.sesMessageId,
          status: delivery.status,
          updatedAt: delivery.updatedAt,
        },
      ],
    };
    expect(Schema.decodeUnknownSync(DeliveriesListResponseSchema)(response)).toEqual(response);
  });

  it("decodes delivery detail with full job, mailing, and attempt fields", () => {
    const response = {
      attempts: [
        {
          attemptNo: 1,
          errorMessage: null,
          finishedAt: "2026-07-03T12:01:00.000Z",
          id: "attempt_1",
          sesMessageId: "ses_1",
          startedAt: "2026-07-03T12:00:30.000Z",
          status: "succeeded",
        },
      ],
      delivery,
      job: {
        attempts: 1,
        createdAt: "2026-07-03T12:00:00.000Z",
        id: "job_1",
        lastError: null,
        lockedBy: null,
        lockedUntil: null,
        maxAttempts: 10,
        runAt: "2026-07-03T12:00:00.000Z",
        state: "succeeded",
        updatedAt: "2026-07-03T12:01:00.000Z",
      },
      mailing: {
        createdAt: "2026-07-03T11:59:00.000Z",
        id: "mailing_1",
        name: null,
        purpose: "transactional",
        scheduledAt: null,
        state: "completed",
        subject: "Hello",
        updatedAt: "2026-07-03T12:01:00.000Z",
      },
    };
    expect(Schema.decodeUnknownSync(DeliveryDetailResponseSchema)(response)).toEqual(response);
    expectTypeOf<DeliveryDetailResponse["job"]>().toMatchTypeOf<object | null>();
  });

  it("rejects nullable fields that are required on the wire", () => {
    expect(() =>
      Schema.decodeUnknownSync(DeliveryDetailResponseSchema)({
        attempts: [],
        delivery: { ...delivery, email: null },
        job: null,
        mailing: {
          createdAt: "2026-07-03T11:59:00.000Z",
          id: "mailing_1",
          name: null,
          purpose: "transactional",
          scheduledAt: null,
          state: "completed",
          subject: "Hello",
          updatedAt: "2026-07-03T12:01:00.000Z",
        },
      }),
    ).toThrow(/email/);
  });
});
