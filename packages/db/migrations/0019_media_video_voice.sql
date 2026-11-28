-- Sprint 19 (Phase 6): video processing with FFmpeg on a Media Worker and AI voice-over (spec Part 12).
-- Video jobs reuse content.media_outputs (one item per job and size, plus the cover picture). A
-- voice-over is a call to a cloud voice; its cost is recorded with the other AI calls, linked to
-- the text item it read, so the Cost Governor counts it against the AI budget.

ALTER TABLE ai.provider_calls ADD COLUMN content_item_id uuid REFERENCES content.items(id);

-- The video jobs of a source video, for its page in the library.
CREATE INDEX worker_jobs_media_video_asset ON infra.worker_jobs (tenant_id, (input ->> 'assetId'))
  WHERE kind = 'media.video';
