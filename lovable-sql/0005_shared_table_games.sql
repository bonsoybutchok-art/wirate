-- One shared game per cash table, so every real player seated at the same table plays the SAME hand
-- (same dealer, same cards, same flop/turn/river) in real time. AI only fill seats real players leave empty.
-- Service-role only, like table_game_states: browsers never read or write the deck.
CREATE TABLE IF NOT EXISTS public.table_games (
  table_id uuid PRIMARY KEY REFERENCES public.poker_tables(id) ON DELETE CASCADE,
  bot_level text NOT NULL DEFAULT 'normal' CHECK (bot_level IN ('easy', 'normal', 'hard')),
  state jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.table_games FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.table_games TO service_role;
ALTER TABLE public.table_games ENABLE ROW LEVEL SECURITY;
