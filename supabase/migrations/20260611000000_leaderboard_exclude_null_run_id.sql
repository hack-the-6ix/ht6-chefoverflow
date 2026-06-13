-- Keep unverified rows off the public leaderboard.
--
-- run_id was added to public.leaderboard as a nullable column after the table
-- already existed, so legacy/pre-migration rows carry run_id = null. Every
-- current write path stamps a real run_id: the submit_run RPC always passes the
-- token's uuid, and api/submit-score.js rejects a null/missing run_id up front
-- (bad_run_id). A null run_id therefore marks a row that was never replay-
-- verified — it should not appear on the leaderboard.
--
-- Recreate the public view to filter those rows out. Must drop + recreate
-- because the column list is unchanged but we want the WHERE clause; CREATE OR
-- REPLACE would work here, but we keep drop/recreate to mirror the previous
-- migration's pattern and stay robust to future column renames.

drop view if exists public.leaderboard_public;
create view public.leaderboard_public as
select
    score,
    grade,
    streak,
    delivered,
    time_secs,
    coalesce(
        nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
        substr(email, 1, 1) || '***@' || split_part(email, '@', 2)
    ) as display_name,
    created_at
from public.leaderboard
where run_id is not null;

grant select on public.leaderboard_public to anon, authenticated;
