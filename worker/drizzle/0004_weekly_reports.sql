CREATE TABLE weekly_reports (
  week_start INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL,
  message_id INTEGER
);
--> statement-breakpoint
CREATE INDEX guesses_submitted ON guesses(submitted);
