-- Home presentation is independent of publication status and access permissions.
ALTER TABLE publication_listings ADD COLUMN home_display TEXT NOT NULL DEFAULT ''
  CHECK (home_display IN ('', 'recommended', 'normal', 'hidden'));
