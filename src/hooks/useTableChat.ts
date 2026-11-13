import { useEffect, useMemo, useRef, useState } from 'react';
import { useBotChat } from '@/hooks/useBotChat';
import type { ChatMessage } from '@/poker/chat';
import { buildHandResult } from '@/poker/showdown';
import { onlyTableMessages, seatChangeMessages, showdownMessages, tableMembers, type TableMember } from '@/poker/table-chat';
import type { TableState } from '@/poker/types';

/**
 * Everything shown in a table's chat: real players, AI banter and the showdown reveal,
 * limited to the people who are inside the table. Also returns who is seated for the chat header.
 *
 * `restrictHumans`: hide other real players who are not seated at this table (cash tables).
 */
export function useTableChat(
  table: TableState | null | undefined,
  active: boolean,
  playerMessages: ChatMessage[],
  restrictHumans: boolean,
) {
  const members = useMemo(() => tableMembers(table), [table]);
  const botMessages = useBotChat(table ?? null, active);
  const [showdown, setShowdown] = useState<ChatMessage[]>([]);

  // Everyone still in the hand shows their cards in the chat, once per hand.
  const handNumber = table?.hand?.number ?? null;
  const showdownDone = !!table?.hand && table.hand.street === 'complete' && table.hand.showdown;
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !table || !showdownDone || handNumber === null || announced.current === handNumber) return;
    announced.current = handNumber;
    const lines = showdownMessages(buildHandResult(table));
    if (lines.length > 0) setShowdown((previous) => [...previous, ...lines].slice(-40));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handNumber, showdownDone]);

  // Say when someone leaves (for example an AI that lost all chips) and who takes the seat.
  const [seatNotes, setSeatNotes] = useState<ChatMessage[]>([]);
  const previousMembers = useRef<TableMember[] | null>(null);
  useEffect(() => {
    const before = previousMembers.current;
    previousMembers.current = members;
    if (!active || !before || before.length === 0 || members.length === 0) return;
    const notes = seatChangeMessages(before, members);
    if (notes.length > 0) setSeatNotes((previous) => [...previous, ...notes].slice(-20));
  }, [members, active]);

  const messages = useMemo(
    () =>
      onlyTableMessages([...playerMessages, ...botMessages, ...showdown, ...seatNotes], members, restrictHumans).sort(
        (a, b) => a.timestamp - b.timestamp,
      ),
    [playerMessages, botMessages, showdown, seatNotes, members, restrictHumans],
  );
  return { messages, members };
}
