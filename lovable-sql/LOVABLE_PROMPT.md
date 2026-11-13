# Prompt para kay Lovable

Apply `lovable-sql/0005_shared_table_games.sql` as a new database migration. It creates ONE new table,
`public.table_games` (one row per cash table, service-role only: RLS enabled, no access for
anon/authenticated). Do not change any other table or function.

Why: cash tables are now ONE shared game per table. Every real player seated at the same table plays the
same hand (same dealer, same hole-card deal, same flop/turn/river) in real time. The server code in
`src/lib/table-game.functions.ts` already reads and writes `table_games` with the service-role client, and
keeps using `table_game_states` only as a per-player "sits at this table" pointer, and `server_buy_in` /
`server_cash_out` unchanged.

After the migration is applied:
1. Regenerate `src/integrations/supabase/types.ts` so `table_games` is typed.
2. Make sure Supabase Realtime Broadcast is enabled for the project (clients use the public broadcast
   channel `table-game:<tableId>` only as a "refresh now" ping; game data never goes through it).
3. Do not edit `src/lib/table-game.functions.ts`, `src/poker/shared-table.ts` or `src/hooks/usePokerTable.ts`.
