#ifndef WDC_IPC_H
#define WDC_IPC_H

#include <stddef.h>
#include <stdint.h>

/*
 * The channel between wdcomp and the node server: length-prefixed messages
 * over a pipe (stdin/stdout), one type byte each.
 *
 *   [4-byte big-endian length][type byte][payload]
 *
 * Everything is fixed-layout binary rather than JSON, in both directions.
 * That keeps a JSON parser out of the compositor entirely, and node decodes
 * it with a Buffer in a dozen lines. Logs still go to stderr, so stdout
 * carries nothing but frames.
 */

/* wdcomp -> node */
#define IPC_WINDOW  'W' /* id, w, h, parent u32, str title, str app_id      */
#define IPC_POPUP   'U' /* id, parent u32, x i32, y i32, w u32, h u32       */
#define IPC_TITLE   'T' /* id u32, str title                                */
#define IPC_CLOSED  'X' /* id u32                                           */
#define IPC_FRAME   'F' /* id, x, y, w, h, full_w, full_h u32, flags u8, px */
#define IPC_BOUNDS  'N' /* id, min_w, min_h, max_w, max_h u32               */
#define IPC_MOVE    'V' /* id u32 — the application asked to be dragged     */
#define IPC_RESIZE  'Z' /* id u32, edges u32 — ...or to be resized          */
#define IPC_CURSOR  'R' /* shape u32 — a cursor-shape-v1 value, 0 for hidden */
#define IPC_COPY    'Y' /* utf-8 — the application put this on the clipboard */
#define IPC_LOG     'L' /* utf-8 message                                    */
#define IPC_CLIENT  'E' /* count u32 — connected Wayland clients, on change */

/* node -> wdcomp */
#define IPC_CONFIGURE 'C' /* id u32, w u32, h u32                            */
#define IPC_ACK       'A' /* id u32                                          */
#define IPC_CLOSE     'K' /* id u32                                          */
#define IPC_POINTER   'P' /* id u32, kind u8, x i32, y i32, arg u32, value i32 */
#define IPC_KEY       'D' /* id u32, evdev keycode u32, pressed u8           */
#define IPC_FOCUS     'G' /* id u32, focused u8                              */
#define IPC_PASTE     'Y' /* utf-8 — the browser's clipboard, for the app     */

/* IPC_POINTER kinds. Button events carry the browser's button index in `arg`;
 * axis events carry the axis in `arg` and the delta, in pixels, in `value`. */
#define IPC_POINTER_ENTER  0
#define IPC_POINTER_MOTION 1
#define IPC_POINTER_LEAVE  2
#define IPC_POINTER_BUTTON 3
#define IPC_POINTER_AXIS   4

/* IPC_FRAME flags */
#define IPC_FRAME_DEFLATE 0x01

struct ipc;

/** Dispatched for each complete message read. */
typedef void (*ipc_handler)(uint8_t type, const uint8_t *payload, size_t len,
	void *user);

struct ipc *ipc_create(int in_fd, int out_fd);
void ipc_destroy(struct ipc *ipc);

/** Sends one message; `body` may be NULL. Returns 0, or -1 if the pipe died. */
int ipc_send(struct ipc *ipc, uint8_t type, const void *head, size_t head_len,
	const void *body, size_t body_len);

/**
 * Reads whatever is available and dispatches every complete message.
 * Returns 0, or -1 when the far end has closed.
 */
int ipc_read(struct ipc *ipc, ipc_handler handler, void *user);

/* Helpers for building fixed-layout payloads. */
void ipc_put_u32(uint8_t *p, uint32_t v);
uint32_t ipc_get_u32(const uint8_t *p);

#endif
