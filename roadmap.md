# Master Poker migration
- [x] Copy app code, images and settings into this project.
- [x] Set up the database (schema 0000-0004) in Lovable Cloud.
- [x] Apply lovable-sql/0005 (table_games, service-role only), regenerate types, confirm Realtime Broadcast; leave table-game.functions.ts, shared-table.ts, usePokerTable.ts untouched.
- [ ] Verify build, tests and main flows.
- [ ] Import existing players and data (waiting on user's exports).
- [ ] Owner payment QR image: original file is gone; admin uploads it in Admin > QR codes.
- [ ] Netlify copy: after publishing, point its LOVABLE_APP_ORIGIN and backend settings at this project.
