-- Sprint 20 (Phase 6): automatic quality checks before review (spec Part 12: tự động kiểm tra chất
-- lượng; M30: bảo vệ chính sách nền tảng). The checks themselves need no table: they run on the
-- current version each time. To check sizes and lengths, a version keeps what was read from its
-- file when it was stored (image and video size, video and audio length).

ALTER TABLE content.item_versions
  ADD COLUMN media_width integer CHECK (media_width > 0),
  ADD COLUMN media_height integer CHECK (media_height > 0),
  ADD COLUMN duration_ms integer CHECK (duration_ms >= 0);
