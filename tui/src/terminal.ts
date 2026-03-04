/**
 * Terminal lifecycle utilities.
 *
 * ANSI escape sequences for entering/leaving the alternate screen,
 * cursor visibility, and screen clearing. Used by main.ts for
 * terminal setup/teardown.
 */

const ESC = "\x1b[";

export const hide_cursor = `${ESC}?25l`;
export const show_cursor = `${ESC}?25h`;
export const enter_alt = `${ESC}?1049h`;
export const leave_alt = `${ESC}?1049l`;
