import { rankLabel, suitSymbol, type Card } from '@/poker/cards';
import { makeMessage, type ChatMessage } from '@/poker/chat';
import { explainWin } from '@/poker/showdown';
import type { HandResult, TableState } from '@/poker/types';

/** Everyone sitting at the table right now (people, AI and spectators). Chat is limited to them. */
export interface TableMember {
  id: string;
  name: string;
  isBot: boolean;
  isMe: boolean;
  sittingOut: boolean;
}

type Rng = () => number;

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function tableMembers(table: TableState | null | undefined): TableMember[] {
  if (!table) return [];
  return table.seats.flatMap((seat) =>
    seat ? [{ id: seat.id, name: seat.name, isBot: seat.isBot, isMe: seat.isMe, sittingOut: seat.sittingOut }] : [],
  );
}

/**
 * Keep only chat from people who are inside the table.
 * - System notes and your own messages always stay.
 * - AI messages stay only while that AI still has a seat (a replaced AI disappears from the chat).
 * - Other real players stay only while seated, when `restrictHumans` is on (cash tables).
 */
export function onlyTableMessages(
  messages: ChatMessage[],
  members: TableMember[],
  restrictHumans: boolean,
): ChatMessage[] {
  return messages.filter((message) => {
    if (message.isSystem || message.isMe) return true;
    if (!message.isBot && !restrictHumans) return true;
    return members.some((member) => sameName(member.name, message.author));
  });
}

export function cardsText(cards: Card[]): string {
  return cards.map((card) => `${rankLabel(card.rank)}${suitSymbol(card.suit)}`).join(' ');
}

/**
 * Chat lines for a showdown: everyone still in the hand shows their cards, strongest hand first,
 * then who won and why. Only seats that really reached the showdown are listed.
 */
export function showdownMessages(result: HandResult | null, now = Date.now()): ChatMessage[] {
  const reveals = result?.reveals ?? [];
  if (!result || !result.showdown || reveals.length === 0) return [];
  const ranked = [...reveals].sort((a, b) => b.score - a.score);
  const lines = [
    `🃏 Hand #${result.handNumber} — ipinakita ang mga baraha`,
    ...ranked.map(
      (reveal, index) =>
        `${index === 0 && reveal.won ? '🏆' : '•'} ${reveal.name}: ${cardsText(reveal.hole)} → ${reveal.handName}${reveal.won ? ' (panalo)' : ''}`,
    ),
  ];
  const why = explainWin(reveals);
  if (why) lines.push(`👑 ${why}`);
  return lines.map((text, index) => ({ ...makeMessage('Table', text, false, false, true), timestamp: now + index }));
}

const PLAIN_TEASE = [
  'Uy {name}, bluff ba yan? 😏',
  '{name}, takot ka ba? 😜',
  'Hoy {name}, huwag kang pabigla-bigla! 😂',
  'Sige {name}, all-in ka na! 🔥',
  '{name}, kabado ka ata ngayon 😅',
  'Tingnan natin kung gaano katapang ang chips mo, {name} 😎',
  '{name}, parang ang tagal mong mag-isip ah 🤔',
  'Mag-ingat ka sa akin {name}, mainit ang kamay ko ngayon 🔥',
];

const GLOAT = [
  'Talo ka diyan {name}! 😎',
  'Sorry {name}, akin na ang pot 😂',
  'Sayang {name}, {hand} lang ang hawak mo 😜',
  'Ayos! Salamat sa chips, {name} 💰',
];

const GROAN = [
  'Grabe ang swerte mo {name}! 😤',
  'Bawi ako sa susunod, {name}! 💪',
  'Sino nagturo sa iyo mag-bluff, {name}? 😂',
  'Hmp, {name}, enjoy mo muna yan 😅',
];

function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}

function fill(template: string, name: string, hand = ''): string {
  return template.replaceAll('{name}', name).replaceAll('{hand}', hand);
}

/** A friendly tease from one AI seat to another person at the same table. */
export function teaseLine(targetName: string, rng: Rng = Math.random): string {
  return fill(pick(PLAIN_TEASE, rng), targetName);
}

export interface BanterLine {
  speaker: string;
  text: string;
  delayMs: number;
}

/**
 * After a showdown, AI winners tease a player who lost and AI losers grumble at the winner.
 * Both the speaker and the person addressed are seats that were in that hand.
 */
export function showdownBanter(result: HandResult, members: TableMember[], rng: Rng = Math.random): BanterLine[] {
  const reveals = result.reveals ?? [];
  if (!result.showdown || reveals.length < 2) return [];
  const isBot = (name: string) => members.some((member) => member.isBot && sameName(member.name, name));
  const winners = reveals.filter((reveal) => reveal.won);
  const losers = reveals.filter((reveal) => !reveal.won);
  if (winners.length === 0 || losers.length === 0) return [];

  const lines: BanterLine[] = [];
  const botWinner = winners.find((reveal) => isBot(reveal.name));
  if (botWinner) {
    const target = pick(losers, rng);
    lines.push({ speaker: botWinner.name, text: fill(pick(GLOAT, rng), target.name, botWinner.handName), delayMs: 1500 });
  }
  const botLosers = losers.filter((reveal) => isBot(reveal.name));
  if (botLosers.length > 0) {
    const speaker = pick(botLosers, rng);
    const target = pick(winners, rng);
    lines.push({ speaker: speaker.name, text: fill(pick(GROAN, rng), target.name), delayMs: 3500 });
  }
  return lines;
}

/** System notes for people who left the table and people who took a seat, compared with the previous roster. */
export function seatChangeMessages(previous: TableMember[], current: TableMember[], now = Date.now()): ChatMessage[] {
  const left = previous.filter((old) => !current.some((member) => member.id === old.id));
  const joined = current.filter((member) => !previous.some((old) => old.id === member.id));
  const lines = [
    ...left.map((member) => `👋 ${member.name}${member.isBot ? ' (AI)' : ''} ay umalis sa table`),
    ...joined.map((member) => `🪑 ${member.name}${member.isBot ? ' (AI)' : ''} ay umupo sa table`),
  ];
  return lines.map((text, index) => ({ ...makeMessage('Table', text, false, false, true), timestamp: now + index }));
}
