CREATE TABLE wordthing.runner_leaderboard (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL UNIQUE,
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 20),
  score integer NOT NULL CHECK (score >= 0),
  distance integer NOT NULL CHECK (distance >= 0),
  played_on timestamptz NOT NULL
);

ALTER TABLE wordthing.runner_leaderboard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wordthing.runner_leaderboard FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE wordthing.runner_leaderboard_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON wordthing.runner_leaderboard TO wordthing_runtime;
GRANT USAGE ON SEQUENCE wordthing.runner_leaderboard_id_seq TO wordthing_runtime;
CREATE POLICY runner_leaderboard_select ON wordthing.runner_leaderboard FOR SELECT TO wordthing_runtime USING (true);
CREATE POLICY runner_leaderboard_insert ON wordthing.runner_leaderboard FOR INSERT TO wordthing_runtime WITH CHECK (true);
CREATE POLICY runner_leaderboard_delete ON wordthing.runner_leaderboard FOR DELETE TO wordthing_runtime USING (true);
