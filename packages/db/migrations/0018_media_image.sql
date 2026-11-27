-- Sprint 18 (Phase 6): image processing on a Media Worker (spec Part 13 and Part 26).
-- A media.image worker job turns one source image into one new image item per chosen size. Each
-- output is saved once per job and size, so a worker that sends the same image again (after a lost
-- answer, or when the job moved to another worker) does not make a second item.

-- The worker job that made a version's file.
ALTER TABLE content.item_versions ADD COLUMN worker_job_id uuid REFERENCES infra.worker_jobs(id);

CREATE TABLE content.media_outputs (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  job_id      uuid NOT NULL REFERENCES infra.worker_jobs(id),
  preset      text NOT NULL CHECK (preset ~ '^[a-z][a-z0-9_]{1,39}$'),
  item_id     uuid NOT NULL REFERENCES content.items(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, preset)
);
CREATE INDEX media_outputs_item ON content.media_outputs (item_id);

-- The image jobs of a source image, for its page in the library.
CREATE INDEX worker_jobs_media_asset ON infra.worker_jobs (tenant_id, (input ->> 'assetId'))
  WHERE kind = 'media.image';

ALTER TABLE content.media_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.media_outputs FORCE ROW LEVEL SECURITY;
CREATE POLICY media_outputs_access ON content.media_outputs
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT ON content.media_outputs TO maris_app;
