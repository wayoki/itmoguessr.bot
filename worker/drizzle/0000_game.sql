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
