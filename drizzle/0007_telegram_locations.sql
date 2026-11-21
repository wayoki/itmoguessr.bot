CREATE TABLE locations (
  file_unique_id TEXT PRIMARY KEY, file_id TEXT NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  author_points INTEGER NOT NULL CHECK(author_points BETWEEN 0 AND 5000),
  owner INTEGER NOT NULL, created INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE location_upload_sessions (
  user INTEGER PRIMARY KEY, step TEXT NOT NULL CHECK(step IN ('off','video','coordinates','points')),
  last_message INTEGER NOT NULL, file_id TEXT, file_unique_id TEXT,
  latitude REAL, longitude REAL
);
