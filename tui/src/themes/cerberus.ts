/**
 * Cerberus theme — amber phosphor on dark.
 *
 * Matches the user's kitty terminal: amber (#F08020) foreground,
 * near-black (#0D0500) background, CRT scanline aesthetic.
 * All colors are amber-family: no blue, no green, just warm phosphor.
 */

import type { Theme } from "../theme";

const ESC = "\x1b[";

export const cerberus: Theme = {
  name: "cerberus",

  // Reset
  reset:    `${ESC}0m`,

  // Style modifiers
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  italic:   `${ESC}3m`,

  // Foreground colors — amber phosphor palette
  accent:   `${ESC}38;2;240;128;32m`,     // #F08020 — primary amber
  text:     `${ESC}38;2;240;128;32m`,      // #F08020 — phosphor foreground
  muted:    `${ESC}38;2;102;51;0m`,        // #663300 — dim amber
  error:    `${ESC}38;2;224;64;32m`,       // #E04020 — hot ember
  warning:  `${ESC}38;2;232;144;48m`,      // #E89030 — bright amber
  success:  `${ESC}38;2;179;90;0m`,        // #B35A00 — warm amber-green
  prompt:   `${ESC}38;2;240;128;32m`,      // #F08020 — amber
  tool:     `${ESC}38;2;204;122;0m`,       // #CC7A00 — ochre
  command:  `${ESC}38;2;242;136;32m`,      // #F28820 — bright phosphor

  // Vim mode indicators
  vimNormal: `${ESC}38;2;240;128;32m`,     // #F08020 — amber
  vimInsert: `${ESC}38;2;232;144;48m`,     // #E89030 — lighter amber
  vimVisual: `${ESC}38;2;204;40;0m`,       // #CC2800 — deep ember

  // Background colors — near-black with amber tints
  topbarBg:      `${ESC}48;2;61;24;0m`,       // #3D1800 — dark amber bar
  userBg:        `${ESC}48;2;26;10;0m`,        // #1A0A00 — slightly warm black
  sidebarBg:     `${ESC}48;2;16;6;0m`,         // #100600 — near black
  sidebarSelBg:  `${ESC}48;2;61;24;0m`,        // #3D1800 — selected highlight
  sidebarHoverBg: `${ESC}48;2;35;15;0m`,       // #230F00 — subtle hover
  cursorBg:      `${ESC}48;2;240;128;32m`,     // #F08020 — full amber
  historyLineBg: `${ESC}48;2;26;10;0m`,        // #1A0A00 — matches userBg
  selectionBg:   `${ESC}48;2;61;24;0m`,        // #3D1800 — amber selection
  appBg:         "",                            // transparent — lets kitty scanlines show through
  cursorColor:   "#F08020",                    // matches kitty cursor

  // Border colors
  borderFocused:   `${ESC}38;2;240;128;32m`,   // #F08020 — amber
  borderUnfocused: `${ESC}38;2;61;24;0m`,      // #3D1800 — dim amber

  // Style end
  boldOff: `${ESC}22m`,
  italicOff: `${ESC}23m`,
};
