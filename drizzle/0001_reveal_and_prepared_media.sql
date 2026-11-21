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
