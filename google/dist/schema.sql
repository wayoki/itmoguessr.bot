CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY, slot TEXT UNIQUE, folder TEXT NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  chat TEXT NOT NULL, ends INTEGER NOT NULL, message_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('publishing','active','failed','uncertain','closed')),
  updated INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX used_folder ON rounds(folder) WHERE status <> 'failed';
--> statement-breakpoint
CREATE INDEX round_deadline ON rounds(status,ends);
--> statement-breakpoint
CREATE TABLE selected (user INTEGER PRIMARY KEY, round INTEGER NOT NULL REFERENCES rounds(id));
--> statement-breakpoint
CREATE TABLE guesses (
  round INTEGER NOT NULL REFERENCES rounds(id), user INTEGER NOT NULL, name TEXT NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  announcement TEXT NOT NULL, submitted INTEGER NOT NULL,
  distance REAL, points INTEGER CHECK(points BETWEEN 0 AND 5000),
  PRIMARY KEY(round,user)
);
--> statement-breakpoint
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY, round INTEGER NOT NULL REFERENCES rounds(id), user INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('guess','result','reveal')), chat TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL, message_id INTEGER,
  UNIQUE(round,user,kind)
);
--> statement-breakpoint
CREATE INDEX outbox_pending ON outbox(status,updated,id);
--> statement-breakpoint
CREATE TRIGGER guess_notice AFTER INSERT ON guesses BEGIN
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.round,new.user,'guess',new.announcement,new.submitted);
END;
--> statement-breakpoint
CREATE TRIGGER closed_round_notice AFTER UPDATE OF status ON rounds
WHEN old.status='active' AND new.status='closed' BEGIN
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'reveal',new.chat,new.updated);
  INSERT INTO outbox(round,user,kind,chat,updated)
    SELECT round,user,'result',CAST(user AS TEXT),new.updated FROM guesses WHERE round=new.id;
END;

ALTER TABLE guesses ADD COLUMN username TEXT;
--> statement-breakpoint
DROP TRIGGER guess_notice;
--> statement-breakpoint
DROP TRIGGER closed_round_notice;
--> statement-breakpoint
ALTER TABLE outbox RENAME TO previous_outbox;
--> statement-breakpoint
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY, round INTEGER NOT NULL REFERENCES rounds(id), user INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('guess','result','reveal','location','inventory')), chat TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL, message_id INTEGER,
  UNIQUE(round,user,kind)
);
--> statement-breakpoint
INSERT INTO outbox SELECT * FROM previous_outbox;
--> statement-breakpoint
DROP TABLE previous_outbox;
--> statement-breakpoint
CREATE INDEX outbox_pending ON outbox(status,updated,id);
--> statement-breakpoint
CREATE TRIGGER guess_notice AFTER INSERT ON guesses BEGIN
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.round,new.user,'guess',new.announcement,new.submitted);
END;
--> statement-breakpoint
CREATE TRIGGER closed_round_notice AFTER UPDATE OF status ON rounds
WHEN old.status='active' AND new.status='closed' BEGIN
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'location',new.chat,new.updated);
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'reveal',new.chat,new.updated);
  INSERT INTO outbox(round,user,kind,chat,updated)
    SELECT round,user,'result',CAST(user AS TEXT),new.updated FROM guesses WHERE round=new.id;
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'inventory','',new.updated);
END;
--> statement-breakpoint
CREATE TABLE prepared_media (
  file_id TEXT NOT NULL, source_version TEXT NOT NULL, object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 50000000),
  width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
  duration INTEGER NOT NULL CHECK(duration > 0), updated INTEGER NOT NULL,
  PRIMARY KEY(file_id,source_version)
);

CREATE TRIGGER corrected_round_notice AFTER UPDATE OF latitude,longitude ON rounds
WHEN old.status='closed' AND new.status='closed'
  AND (old.latitude<>new.latitude OR old.longitude<>new.longitude) BEGIN
  INSERT INTO settings VALUES('correction:' || new.id,'1')
    ON CONFLICT(key) DO UPDATE SET value='1';
  UPDATE guesses SET distance=NULL,points=NULL WHERE round=new.id;
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'location',new.chat,new.updated)
    ON CONFLICT(round,user,kind) DO UPDATE SET status='pending',updated=new.updated,message_id=NULL;
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'reveal',new.chat,new.updated)
    ON CONFLICT(round,user,kind) DO UPDATE SET status='pending',updated=new.updated,message_id=NULL;
  INSERT INTO outbox(round,user,kind,chat,updated)
    SELECT round,user,'result',CAST(user AS TEXT),new.updated FROM guesses WHERE round=new.id
    ON CONFLICT(round,user,kind) DO UPDATE SET status='pending',updated=new.updated,message_id=NULL;
END;

CREATE TABLE retired_locations (folder TEXT PRIMARY KEY);
--> statement-breakpoint
DROP TRIGGER closed_round_notice;
--> statement-breakpoint
CREATE TRIGGER closed_round_notice AFTER UPDATE OF status ON rounds
WHEN old.status='active' AND new.status='closed' BEGIN
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'location',new.chat,new.updated);
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'reveal',new.chat,new.updated);
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'inventory','',new.updated);
END;
--> statement-breakpoint
DROP TRIGGER corrected_round_notice;
--> statement-breakpoint
CREATE TRIGGER corrected_round_notice AFTER UPDATE OF latitude,longitude ON rounds
WHEN old.status='closed' AND new.status='closed'
  AND (old.latitude<>new.latitude OR old.longitude<>new.longitude) BEGIN
  INSERT INTO settings VALUES('correction:' || new.id,'1')
    ON CONFLICT(key) DO UPDATE SET value='1';
  UPDATE guesses SET distance=NULL,points=NULL WHERE round=new.id;
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'location',new.chat,new.updated)
    ON CONFLICT(round,user,kind) DO UPDATE SET status='pending',updated=new.updated,message_id=NULL;
  INSERT INTO outbox(round,user,kind,chat,updated) VALUES(new.id,0,'reveal',new.chat,new.updated)
    ON CONFLICT(round,user,kind) DO UPDATE SET status='pending',updated=new.updated,message_id=NULL;
END;

CREATE TABLE weekly_reports (
  week_start INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL,
  message_id INTEGER
);
--> statement-breakpoint
CREATE INDEX guesses_submitted ON guesses(submitted);

ALTER TABLE weekly_reports ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE monthly_reports (
  month_start INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL,
  message_id INTEGER
);

ALTER TABLE rounds ADD COLUMN author_points INTEGER CHECK(author_points BETWEEN 0 AND 5000);

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

CREATE TABLE google_updates (id INTEGER PRIMARY KEY, status TEXT NOT NULL, updated INTEGER NOT NULL);
