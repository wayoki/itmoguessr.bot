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
