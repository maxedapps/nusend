-- migrate:up
CREATE INDEX mailings_created_id_idx ON mailings (created_at DESC, id DESC);

-- migrate:down
DROP INDEX mailings_created_id_idx;
