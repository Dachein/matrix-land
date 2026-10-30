ALTER TABLE skill_catalog_metadata ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE app_catalog_metadata ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE publication_listings ADD COLUMN cover_image_url TEXT NOT NULL DEFAULT '';
