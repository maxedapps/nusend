-- migrate:up
CREATE INDEX ses_events_created_id_idx ON ses_events (created_at DESC, id DESC);
CREATE INDEX deliveries_created_id_idx ON deliveries (created_at DESC, id DESC);
CREATE UNIQUE INDEX jobs_delivery_id_unique_idx ON jobs (delivery_id);

-- migrate:down
DROP INDEX jobs_delivery_id_unique_idx;
DROP INDEX deliveries_created_id_idx;
DROP INDEX ses_events_created_id_idx;
