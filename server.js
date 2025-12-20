
/*
  server.js — duration minutes support
  Base: your last WORKING server.js (with pools + capacity edit + CORS fix)
  Change: plans can now use duration_minutes (15min, 30min, etc)
*/

// ⚠️ This file assumes:
//   ALTER TABLE plans ADD COLUMN duration_minutes integer;

//
// IMPORTANT:
// This is the SAME server you are running now,
// with ONLY plans-duration logic added.
//

