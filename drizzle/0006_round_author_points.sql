ALTER TABLE rounds ADD COLUMN author_points INTEGER CHECK(author_points BETWEEN 0 AND 5000);
