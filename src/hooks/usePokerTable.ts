import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useServerFn } from '@tanstack/react-start';
import { errorMessage } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import {
  actAtTable,
  getTableGame,
  leaveTable,
  sitDownAtTable,
  tickTableGame,
  type TableGameResult,
} from '@/lib/table-game.functions';
import { emptyTable, legalActions } from '@/poker/engine';
import { buildHandResult } from '@/poker/showdown';
import type { Action, BotLevel, HandResult, TableConfig, TableState } from '@/poker/types';

export { TURN_SECONDS } from '@/poker/session';

const TICK_BUFFER_MS = 150;
const RETRY_MS = 3000;
/** Safety net: even if a realtime ping is missed, every player's screen catches up this often. */
const POLL_MS = 3000;

interface Player {
  id: string;
  name: string;
  avatarUrl: string | null;
  avatarEmoji: string;
}

/**
 * Cash tables are ONE shared game per table, owned by the server: every real player seated at the table sees
 * the same hand, dealer and board in real time. This hook displays this player's view, sends their actions,
 * asks the server to advance the game when the next automatic step is due, and listens for table updates
 * from the other players.
 */
export function usePokerTable(_me: Player, tableConfig: TableConfig, tableId: string) {
  const getGameFn = useServerFn(getTableGame);
  const sitFn = useServerFn(sitDownAtTable);
  const tickFn = useServerFn(tickTableGame);
  const actFn = useServerFn(actAtTable);
  const leaveFn = useServerFn(leaveTable);

  const [table, setTable] = useState<TableState>(emptyTable(tableConfig));
  const [seated, setSeated] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [version, setVersion] = useState(-1);
  const [dueAt, setDueAt] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cashOutBlocked, setCashOutBlocked] = useState(false);
  const [history, setHistory] = useState<HandResult[]>([]);
  const [botLevel, setBotLevel] = useState<BotLevel | null>(null);

  const seatedRef = useRef(false);
  const versionRef = useRef(-1);
  const inFlightRef = useRef(false);
  const refreshingRef = useRef(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const configRef = useRef(tableConfig);
  configRef.current = tableConfig;

  const applyResult = useCallback((result: TableGameResult) => {
    if (result.closed || !result.view) {
      seatedRef.current = false;
      versionRef.current = -1;
      setSeated(false);
      setWaiting(false);
      setLeaving(false);
      setVersion(-1);
      setBotLevel(null);
      setTable(emptyTable(configRef.current));
      return;
    }
    const view = result.view;
    if (seatedRef.current && view.version < versionRef.current) return;
    const changed = view.version !== versionRef.current;
    seatedRef.current = true;
    versionRef.current = view.version;
    setTable(view.table);
    setWaiting(view.waiting);
    setDueAt(Date.now() + view.msUntilNext);
    setVersion(view.version);
    setBotLevel(view.botLevel);
    setSeated(true);
    // Tell the other players at this table that there is something new to fetch.
    if (changed) void channelRef.current?.send({ type: 'broadcast', event: 'table', payload: { version: view.version } });
  }, []);

  const refresh = useCallback(() => {
    if (refreshingRef.current || inFlightRef.current) return;
    refreshingRef.current = true;
    void getGameFn({ data: { tableId } })
      .then((result) => {
        if (result.closed && !seatedRef.current) return;
        applyResult(result);
      })
      .catch(() => undefined)
      .finally(() => {
        refreshingRef.current = false;
      });
  }, [getGameFn, tableId, applyResult]);

  // Resume a seat that is still open on the server (page reload).
  useEffect(() => {
    let active = true;
    void getGameFn({ data: { tableId } })
      .then((result) => {
        if (active && !result.closed) applyResult(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [getGameFn, tableId, applyResult]);

  // Leaving the page cashes out the stack held at the shared table.
  useEffect(
    () => () => {
      if (seatedRef.current) void leaveFn({ data: { tableId } }).catch(() => undefined);
    },
    [leaveFn, tableId]
  );

  // Real time: other players' moves arrive as a ping on the table's channel, plus a slow poll as a safety net.
  useEffect(() => {
    if (!seated) return;
    const channel = supabase.channel(`table-game:${tableId}`, { config: { broadcast: { self: false } } });
    channelRef.current = channel;
    channel
      .on('broadcast', { event: 'table' }, ({ payload }) => {
        const incoming = Number((payload as { version?: unknown } | null)?.version);
        if (!Number.isFinite(incoming) || incoming > versionRef.current) refresh();
      })
      .subscribe();
    const poll = window.setInterval(refresh, POLL_MS);
    return () => {
      window.clearInterval(poll);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [seated, tableId, refresh]);

  // Ask the server to advance when the next automatic step (deal, bot move, timeout) is due.
  useEffect(() => {
    if (!seated || leaving || cashOutBlocked) return;
    const timer = window.setTimeout(() => {
      if (inFlightRef.current) {
        window.setTimeout(() => setRetryNonce((n) => n + 1), 500);
        return;
      }
      inFlightRef.current = true;
      void tickFn({ data: { tableId } })
        .then((result) => {
          const before = versionRef.current;
          applyResult(result);
          // Same version means the server was not ready yet; wait and ask again.
          if (!result.closed && result.view?.version === before) setRetryNonce((n) => n + 1);
        })
        .catch(() => window.setTimeout(() => setRetryNonce((n) => n + 1), RETRY_MS))
        .finally(() => {
          inFlightRef.current = false;
        });
    }, Math.max(0, dueAt - Date.now()) + TICK_BUFFER_MS);
    return () => window.clearTimeout(timer);
  }, [seated, leaving, cashOutBlocked, version, dueAt, retryNonce, tableId, tickFn, applyResult]);

  useEffect(() => {
    const hand = table.hand;
    if (!hand || hand.street !== 'complete') return;
    setHistory((previous) => {
      if (previous[0]?.handNumber === hand.number) return previous;
      const entry = buildHandResult(table);
      if (!entry) return previous;
      return [entry, ...previous].slice(0, 25);
    });
  }, [table]);

  const sitDown = useCallback(
    async (buyIn: number) => {
      setBusy(true);
      setError(null);
      try {
        const result = await sitFn({ data: { tableId, buyIn } });
        setLeaving(false);
        setCashOutBlocked(false);
        applyResult(result);
        if (!result.closed) {
          window.__lovableEvents?.track?.('project.table_joined', {
            big_blind: configRef.current.bigBlind,
            buy_in: buyIn,
          });
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [sitFn, tableId, applyResult]
  );

  const act = useCallback(
    (action: Action) => {
      if (!seatedRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      void actFn({ data: { tableId, action } })
        .then(applyResult)
        .catch((err) => setError(errorMessage(err)))
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [actFn, tableId, applyResult]
  );

  const standUp = useCallback(async (): Promise<boolean> => {
    if (!seatedRef.current) return true;
    setLeaving(true);
    setError(null);
    try {
      const result = await leaveFn({ data: { tableId } });
      applyResult({ closed: true, view: null, balance: result.balance });
      return true;
    } catch (err) {
      setError(errorMessage(err));
      setCashOutBlocked(true);
      setLeaving(false);
      return false;
    }
  }, [leaveFn, tableId, applyResult]);

  const retryCashOut = useCallback(() => {
    setCashOutBlocked(false);
    void standUp();
  }, [standUp]);

  const meIndex = table.seats.findIndex((seat) => seat?.isMe);
  const legal = meIndex === -1 ? null : legalActions(table, meIndex);

  return {
    table,
    seated,
    waiting,
    busy,
    error,
    leaving,
    cashOutBlocked,
    meIndex,
    legal,
    sitDown,
    standUp,
    act,
    retryCashOut,
    history,
    botLevel,
  };
}
