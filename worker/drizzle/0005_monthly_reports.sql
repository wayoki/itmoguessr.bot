ALTER TABLE weekly_reports ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE monthly_reports (
  month_start INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
  updated INTEGER NOT NULL,
  message_id INTEGER
);
