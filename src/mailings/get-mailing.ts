export type MailingSummary = {
  counts: {
    deliveries: number;
    failed: number;
    queued: number;
    sent: number;
    suppressed: number;
  };
  mailing: {
    id: string;
    purpose: string;
    state: string;
    scheduledAt: string | null;
  };
};

export async function getMailingSummary(
  db: D1Database,
  mailingId: string,
): Promise<MailingSummary | null> {
  const [mailing, statusRows] = await Promise.all([
    db
      .prepare(
        "SELECT id, purpose, state, scheduled_at AS scheduledAt FROM mailings WHERE id = ?1;",
      )
      .bind(mailingId)
      .first<MailingSummary["mailing"]>(),
    db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM deliveries WHERE mailing_id = ?1 GROUP BY status;",
      )
      .bind(mailingId)
      .all<{ status: string; count: number }>(),
  ]);

  if (!mailing) return null;

  const byStatus = new Map(statusRows.results.map((row) => [row.status, row.count]));

  return {
    counts: {
      deliveries: statusRows.results.reduce((total, row) => total + row.count, 0),
      failed: byStatus.get("failed") ?? 0,
      queued: byStatus.get("queued") ?? 0,
      sent: byStatus.get("sent") ?? 0,
      suppressed: byStatus.get("suppressed") ?? 0,
    },
    mailing,
  };
}
