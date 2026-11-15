ALTER TABLE wordthing.rooms ADD COLUMN active_activity_id integer REFERENCES wordthing.activities(id) ON DELETE SET NULL;
