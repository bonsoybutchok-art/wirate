import { useEffect, useMemo, useRef, useState } from 'react';
import { aiTableTalk, makeAiMessage, type ChatMessage } from '@/poker/chat';
import { buildHandResult } from '@/poker/showdown';
import { sameName, showdownBanter, teaseLine, tableMembers } from '@/poker/table-chat';
import type { TableState } from '@/poker/types';

/**
 * AI seats chat now and then and tease the people sitting at the same table.
 * Speakers and the people they talk to always come from the current seats.
 * Their messages are marked isBot, so ChatBox always labels them "AI".
 */
export function useBotChat(table: TableState | null, active: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const members = useMemo(() => tableMembers(table), [table]);
  const membersRef = useRef(members);
  membersRef.current = members;
  const hasBots = members.some((member) => member.isBot && !member.sittingOut);

  // Casual table talk, sometimes aimed at another person at the table.
  useEffect(() => {
    if (!active || !hasBots) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const seated = membersRef.current;
        const speakers = seated.filter((member) => member.isBot && !member.sittingOut);
        if (speakers.length > 0) {
          const speaker = speakers[Math.floor(Math.random() * speakers.length)]!;
          const targets = seated.filter((member) => !sameName(member.name, speaker.name));
          const text =
            targets.length > 0 && Math.random() < 0.6
              ? teaseLine(targets[Math.floor(Math.random() * targets.length)]!.name)
              : aiTableTalk();
          setMessages((previous) => [...previous, makeAiMessage({ name: speaker.name }, text)].slice(-30));
        }
        schedule();
      }, 12000 + Math.random() * 18000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, hasBots]);

  // After a showdown the AI seats that were in the hand react to who won.
  const handNumber = table?.hand?.number ?? null;
  const showdownDone = !!table?.hand && table.hand.street === 'complete' && table.hand.showdown;
  const reacted = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !table || !showdownDone || handNumber === null || reacted.current === handNumber) return;
    reacted.current = handNumber;
    const result = buildHandResult(table);
    if (!result) return;
    const timers = showdownBanter(result, membersRef.current).map((line) =>
      setTimeout(() => {
        if (!membersRef.current.some((member) => sameName(member.name, line.speaker))) return;
        setMessages((previous) => [...previous, makeAiMessage({ name: line.speaker }, line.text)].slice(-30));
      }, line.delayMs),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handNumber, showdownDone]);

  return messages;
}
