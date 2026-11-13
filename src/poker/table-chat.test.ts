import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/poker/chat';
import { onlyTableMessages, showdownBanter, showdownMessages, type TableMember } from '@/poker/table-chat';
import type { HandResult } from '@/poker/types';

const members: TableMember[] = [
  { id: 'me', name: 'Juan', isBot: false, isMe: true, sittingOut: false },
  { id: 'b1', name: 'Mae', isBot: true, isMe: false, sittingOut: false },
  { id: 'b2', name: 'Paolo D.', isBot: true, isMe: false, sittingOut: false },
];

const msg = (author: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: author, author, text: 'hi', isMe: false, isBot: false, isSystem: false, timestamp: 1, ...over,
});

describe('onlyTableMessages', () => {
  it('drops AI and (on cash tables) people who are not seated, keeps you and system notes', () => {
    const all = [
      msg('Mae', { isBot: true }),
      msg('Gone Bot', { isBot: true }),
      msg('Juan', { isMe: true }),
      msg('Pedro'),
      msg('Table', { isSystem: true }),
    ];
    expect(onlyTableMessages(all, members, true).map((m) => m.author)).toEqual(['Mae', 'Juan', 'Table']);
    expect(onlyTableMessages(all, members, false).map((m) => m.author)).toEqual(['Mae', 'Juan', 'Pedro', 'Table']);
  });
});

const reveal = (seat: number, name: string, won: boolean, score: number, handName: string) => ({
  seat, name, avatarUrl: null, avatarEmoji: '🙂', hole: [{ rank: 14, suit: 'S' as const }, { rank: 13, suit: 'H' as const }],
  handName, bestFive: [], won, score,
});

const result: HandResult = {
  handNumber: 7, board: [], rake: 0, pot: 100, showdown: true, winners: [],
  reveals: [reveal(0, 'Juan', false, 10, 'One Pair'), reveal(1, 'Mae', true, 20, 'Flush')],
};

describe('showdownMessages', () => {
  it('lists every revealed hand, strongest first, then the winner', () => {
    const lines = showdownMessages(result, 1000).map((m) => m.text);
    expect(lines[0]).toContain('Hand #7');
    expect(lines[1]).toBe('🏆 Mae: A♠ K♥ → Flush (panalo)');
    expect(lines[2]).toBe('• Juan: A♠ K♥ → One Pair');
    expect(lines.at(-1)).toContain('Mae');
  });
  it('says nothing when nobody had to show cards', () => {
    expect(showdownMessages({ ...result, showdown: false })).toEqual([]);
    expect(showdownMessages({ ...result, reveals: [] })).toEqual([]);
  });
});

describe('showdownBanter', () => {
  it('has the seated AI winner tease the player who lost', () => {
    const lines = showdownBanter(result, members, () => 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.speaker).toBe('Mae');
    expect(lines[0]!.text).toContain('Juan');
  });
  it('lets an AI loser grumble at the winner, and never uses names outside the hand', () => {
    const botLoses: HandResult = {
      ...result,
      reveals: [reveal(0, 'Juan', true, 20, 'Flush'), reveal(1, 'Paolo D.', false, 10, 'One Pair')],
    };
    const lines = showdownBanter(botLoses, members, () => 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.speaker).toBe('Paolo D.');
    expect(lines[0]!.text).toContain('Juan');
    expect(lines.some((line) => line.text.includes('Mae'))).toBe(false);
  });
});
