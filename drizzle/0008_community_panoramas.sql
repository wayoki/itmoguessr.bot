ALTER TABLE locations ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video' CHECK(media_type IN ('video','photo'));
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN difficulty INTEGER CHECK(difficulty BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN author_name TEXT;
--> statement-breakpoint
ALTER TABLE rounds ADD COLUMN author_user INTEGER;
--> statement-breakpoint
ALTER TABLE rounds ADD COLUMN author_name TEXT;
--> statement-breakpoint
ALTER TABLE rounds ADD COLUMN difficulty INTEGER CHECK(difficulty BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE location_upload_sessions RENAME TO legacy_location_upload_sessions;
--> statement-breakpoint
CREATE TABLE location_upload_sessions (
  user INTEGER PRIMARY KEY, step TEXT NOT NULL CHECK(step IN ('off','video','coordinates','difficulty','points')),
  last_message INTEGER NOT NULL, file_id TEXT, file_unique_id TEXT,
  latitude REAL, longitude REAL, media_type TEXT NOT NULL DEFAULT 'video' CHECK(media_type IN ('video','photo')),
  difficulty INTEGER CHECK(difficulty BETWEEN 1 AND 5)
);
--> statement-breakpoint
INSERT INTO location_upload_sessions(user,step,last_message,file_id,file_unique_id,latitude,longitude)
  SELECT user,step,last_message,file_id,file_unique_id,latitude,longitude FROM legacy_location_upload_sessions;
--> statement-breakpoint
DROP TABLE legacy_location_upload_sessions;
--> statement-breakpoint
UPDATE rounds SET author_user=(SELECT owner FROM locations WHERE 'telegram:' || file_unique_id=rounds.folder)
  WHERE folder LIKE 'telegram:%';
--> statement-breakpoint
CREATE TABLE panorama_authors (
  user INTEGER PRIMARY KEY, username TEXT UNIQUE
);
--> statement-breakpoint
CREATE TABLE panorama_mutes (
  user INTEGER PRIMARY KEY, admin INTEGER NOT NULL, muted_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE panorama_votes (
  round INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user INTEGER NOT NULL, vote INTEGER NOT NULL CHECK(vote IN (-1,1)),
  updated INTEGER NOT NULL, update_id INTEGER NOT NULL,
  PRIMARY KEY(round,user)
);
--> statement-breakpoint
INSERT INTO settings VALUES ('schema:community_panoramas','1');
