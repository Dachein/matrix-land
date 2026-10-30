ALTER TABLE forum_topics
ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1));

ALTER TABLE forum_topics
ADD COLUMN anonymous_persona TEXT;

ALTER TABLE forum_posts
ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1));

ALTER TABLE forum_posts
ADD COLUMN anonymous_persona TEXT;
