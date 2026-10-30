-- Hide the requested existing App on Home without changing publication or access.
UPDATE publication_listings
SET home_display = 'hidden'
WHERE listing_type = 'app'
  AND target_plane = 'apps'
  AND target_id = 'app_1a9817d4e007';
