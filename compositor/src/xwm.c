/*
 * xwm — see xwm.h.
 *
 * Pairs X windows with their wl_surface, maps what asks to be mapped, passes
 * on titles, sizes, hints and transients, closes politely and hands out
 * focus. Override-redirect windows — menus, tooltips, drop-downs — are
 * reported as such, with where they put themselves, and wdcomp shows them as
 * popups. No decorations, ever: the shell draws the frame.
 *
 * It is also the clipboard's X end. Xwayland bridges no selection, so an X
 * client that copies is only ever heard of here: XFixes says CLIPBOARD
 * changed hands, the text is read out (in INCR pieces when the owner sends
 * it that way — Tk does above 4000 bytes) and reported; and the text the
 * browser or a Wayland client holds is served from a window of ours that
 * takes CLIPBOARD for it. Only CLIPBOARD, only text: PRIMARY has no browser
 * counterpart, and images are a project of their own.
 */
#include "xwm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <sys/uio.h>
#include <xcb/xcb.h>
#include <xcb/xcbext.h>

enum {
	ATOM_WL_SURFACE_ID,
	ATOM_WM_PROTOCOLS,
	ATOM_WM_DELETE_WINDOW,
	ATOM_WM_TAKE_FOCUS,
	ATOM_WM_STATE,
	ATOM_NET_WM_NAME,
	ATOM_UTF8_STRING,
	ATOM_NET_SUPPORTING_WM_CHECK,
	ATOM_CLIPBOARD,
	ATOM_TARGETS,
	ATOM_TIMESTAMP,
	ATOM_INCR,
	ATOM_TEXT,
	ATOM_TEXT_PLAIN_UTF8,
	ATOM_TEXT_PLAIN,
	ATOM_WD_SELECTION,
	ATOM_WM_S0,
	ATOM_COUNT,
};

static const char *const atom_names[ATOM_COUNT] = {
	[ATOM_WL_SURFACE_ID] = "WL_SURFACE_ID",
	[ATOM_WM_PROTOCOLS] = "WM_PROTOCOLS",
	[ATOM_WM_DELETE_WINDOW] = "WM_DELETE_WINDOW",
	[ATOM_WM_TAKE_FOCUS] = "WM_TAKE_FOCUS",
	[ATOM_WM_STATE] = "WM_STATE",
	[ATOM_NET_WM_NAME] = "_NET_WM_NAME",
	[ATOM_UTF8_STRING] = "UTF8_STRING",
	[ATOM_NET_SUPPORTING_WM_CHECK] = "_NET_SUPPORTING_WM_CHECK",
	[ATOM_CLIPBOARD] = "CLIPBOARD",
	[ATOM_TARGETS] = "TARGETS",
	[ATOM_TIMESTAMP] = "TIMESTAMP",
	[ATOM_INCR] = "INCR",
	[ATOM_TEXT] = "TEXT",
	[ATOM_TEXT_PLAIN_UTF8] = "text/plain;charset=utf-8",
	[ATOM_TEXT_PLAIN] = "text/plain",
	/* Where an X client's selection lands when we ask for it. */
	[ATOM_WD_SELECTION] = "_WD_SELECTION",
	[ATOM_WM_S0] = "WM_S0",
};

/* A clipboard is text, not a file transfer — the same line wdcomp draws. */
#define CLIP_MAX (1u << 20)

struct xwm_win {
	xcb_window_t id;
	int32_t x, y, width, height;
	bool override_redirect;
	bool mapped;
	uint32_t surface_id;
	char *title;
	char *app_id;
	xcb_window_t transient_for;
	int32_t min_width, min_height, max_width, max_height;
	struct xwm_win *next;
};

struct xwm {
	xcb_connection_t *conn;
	xcb_screen_t *screen;
	xcb_window_t check;
	/* The root window's cursor, which is what a window without one of its
	 * own inherits; see xwm_create. */
	xcb_font_t cursor_font;
	xcb_cursor_t root_cursor;
	xcb_atom_t atoms[ATOM_COUNT];
	struct xwm_callbacks cb;
	void *data;
	struct xwm_win *windows;

	/* The clipboard's X end: a window of ours that owns CLIPBOARD when the
	 * text is not an X client's, and receives it when it is. */
	xcb_window_t selection;
	uint8_t xfixes_event; /* XFixes' first event code; 0 without XFixes */
	/* What an X client gets when it pastes — the browser's text, a Wayland
	 * client's, or the last X client's, kept after that client has gone. */
	char *clip;
	size_t clip_len;
	bool clip_owned;
	xcb_timestamp_t clip_time;
	/* An X client's selection on its way in: the reply to ConvertSelection,
	 * then — if the owner chose INCR — one property change per piece. */
	struct {
		bool active;
		bool incr;
		xcb_atom_t target;
		xcb_timestamp_t time;
		char *buf;
		size_t len, cap;
	} pull;
	/* Our text on its way out in INCR pieces, to one requestor at a time:
	 * each deletion of the property by the requestor asks for the next. */
	struct {
		xcb_window_t requestor;
		xcb_atom_t property, type;
		char *data;
		size_t len, at;
		time_t started;
	} push;
};

static struct xwm_win *find(struct xwm *xwm, xcb_window_t id) {
	for (struct xwm_win *w = xwm->windows; w; w = w->next)
		if (w->id == id) return w;
	return NULL;
}

static void forget(struct xwm *xwm, xcb_window_t id) {
	for (struct xwm_win **p = &xwm->windows; *p; p = &(*p)->next) {
		if ((*p)->id != id) continue;
		struct xwm_win *w = *p;
		*p = w->next;
		free(w->title);
		free(w->app_id);
		free(w);
		return;
	}
}

/* A property as a NUL-terminated string, or NULL. */
static char *get_string(struct xwm *xwm, xcb_window_t win, xcb_atom_t prop) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 0, win, prop, XCB_GET_PROPERTY_TYPE_ANY,
			0, 1024), NULL);
	if (!r) return NULL;
	char *out = NULL;
	int len = xcb_get_property_value_length(r);
	if (r->format == 8 && len > 0) {
		out = malloc((size_t)len + 1);
		if (out) {
			memcpy(out, xcb_get_property_value(r), (size_t)len);
			out[len] = '\0';
		}
	}
	free(r);
	return out;
}

static void read_title(struct xwm *xwm, struct xwm_win *w) {
	char *t = get_string(xwm, w->id, xwm->atoms[ATOM_NET_WM_NAME]);
	if (!t) t = get_string(xwm, w->id, XCB_ATOM_WM_NAME);
	free(w->title);
	w->title = t;
}

/* WM_CLASS is "instance\0class\0"; the class is the application's name. */
static void read_class(struct xwm *xwm, struct xwm_win *w) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 0, w->id, XCB_ATOM_WM_CLASS,
			XCB_ATOM_STRING, 0, 256), NULL);
	if (!r) return;
	int len = xcb_get_property_value_length(r);
	const char *v = xcb_get_property_value(r);
	size_t first = len > 0 ? strnlen(v, (size_t)len) : 0;
	if ((int)first + 1 < len) {
		free(w->app_id);
		w->app_id = strndup(v + first + 1, (size_t)len - first - 1);
	}
	free(r);
}

static void read_transient_for(struct xwm *xwm, struct xwm_win *w) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 0, w->id, XCB_ATOM_WM_TRANSIENT_FOR,
			XCB_ATOM_WINDOW, 0, 1), NULL);
	if (!r) return;
	w->transient_for = 0;
	if (r->format == 32 && xcb_get_property_value_length(r) >= 4)
		w->transient_for = *(xcb_window_t *)xcb_get_property_value(r);
	free(r);
}

/*
 * WM_NORMAL_HINTS is an XSizeHints: flags, then four obsolete fields, then
 * min and max sizes — 18 CARD32s in all (ICCCM 4.1.2.3). Only the sizes
 * matter here; the shell is the one that decides what to do with them.
 */
static void read_hints(struct xwm *xwm, struct xwm_win *w) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 0, w->id, XCB_ATOM_WM_NORMAL_HINTS,
			XCB_ATOM_WM_SIZE_HINTS, 0, 18), NULL);
	if (!r) return;
	w->min_width = w->min_height = w->max_width = w->max_height = 0;
	if (r->format == 32 && xcb_get_property_value_length(r) >= 9 * 4) {
		const uint32_t *h = xcb_get_property_value(r);
		enum { P_MIN_SIZE = 1 << 4, P_MAX_SIZE = 1 << 5 };
		if (h[0] & P_MIN_SIZE) {
			w->min_width = (int32_t)h[5];
			w->min_height = (int32_t)h[6];
		}
		if (h[0] & P_MAX_SIZE) {
			w->max_width = (int32_t)h[7];
			w->max_height = (int32_t)h[8];
		}
	}
	free(r);
}

static bool supports(struct xwm *xwm, xcb_window_t win, xcb_atom_t protocol) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 0, win, xwm->atoms[ATOM_WM_PROTOCOLS],
			XCB_ATOM_ATOM, 0, 32), NULL);
	if (!r) return false;
	bool found = false;
	xcb_atom_t *atoms = xcb_get_property_value(r);
	int n = xcb_get_property_value_length(r) / (int)sizeof(xcb_atom_t);
	for (int i = 0; i < n; i++)
		if (atoms[i] == protocol) found = true;
	free(r);
	return found;
}

static void send_protocol(struct xwm *xwm, xcb_window_t win, xcb_atom_t protocol) {
	xcb_client_message_event_t ev = {
		.response_type = XCB_CLIENT_MESSAGE,
		.format = 32,
		.window = win,
		.type = xwm->atoms[ATOM_WM_PROTOCOLS],
	};
	ev.data.data32[0] = protocol;
	ev.data.data32[1] = XCB_CURRENT_TIME;
	xcb_send_event(xwm->conn, 0, win, XCB_EVENT_MASK_NO_EVENT, (const char *)&ev);
}

static void report_surface(struct xwm *xwm, struct xwm_win *w) {
	if (!w->mapped || !w->surface_id) return;
	struct xwm_window info = {
		.xwin = w->id,
		.x = w->x,
		.y = w->y,
		.width = w->width,
		.height = w->height,
		.override_redirect = w->override_redirect,
		.title = w->title,
		.app_id = w->app_id,
		.transient_for = w->transient_for,
		.min_width = w->min_width,
		.min_height = w->min_height,
		.max_width = w->max_width,
		.max_height = w->max_height,
	};
	xwm->cb.surface(xwm->data, &info, w->surface_id);
}

/* ---- Clipboard ---------------------------------------------------- */

/* STRING is Latin-1, and some owners have nothing else. */
static char *latin1_to_utf8(const char *in, size_t len, size_t *out_len) {
	char *out = malloc(len * 2 + 1);
	if (!out) return NULL;
	size_t n = 0;
	for (size_t i = 0; i < len; i++) {
		unsigned char c = (unsigned char)in[i];
		if (c < 0x80) {
			out[n++] = (char)c;
		} else {
			out[n++] = (char)(0xC0 | (c >> 6));
			out[n++] = (char)(0x80 | (c & 0x3F));
		}
	}
	out[n] = '\0';
	*out_len = n;
	return out;
}

static char *utf8_to_latin1(const char *in, size_t len, size_t *out_len) {
	char *out = malloc(len + 1);
	if (!out) return NULL;
	size_t n = 0;
	for (size_t i = 0; i < len;) {
		unsigned char c = (unsigned char)in[i];
		int extra = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
		uint32_t cp = extra == 0 ? c : c & (0x3F >> extra);
		for (int k = 1; k <= extra && i + k < len; k++)
			cp = (cp << 6) | ((unsigned char)in[i + k] & 0x3F);
		out[n++] = cp < 0x100 ? (char)cp : '?';
		i += 1 + extra;
	}
	out[n] = '\0';
	*out_len = n;
	return out;
}

static void own_clipboard(struct xwm *xwm) {
	xcb_set_selection_owner(xwm->conn, xwm->selection, xwm->atoms[ATOM_CLIPBOARD],
		XCB_CURRENT_TIME);
}

/* Done reading an X client's selection, with its text or without. */
static void pull_end(struct xwm *xwm, bool ok) {
	char *text = xwm->pull.buf;
	size_t len = xwm->pull.len;
	bool latin1 = xwm->pull.target == XCB_ATOM_STRING;
	memset(&xwm->pull, 0, sizeof xwm->pull);
	if (!ok || !text) {
		free(text);
		return;
	}
	if (latin1) {
		char *utf8 = latin1_to_utf8(text, len, &len);
		free(text);
		if (!utf8) return;
		text = utf8;
	}
	/* Ours to serve again if that client goes away, see the owner event. */
	free(xwm->clip);
	xwm->clip = text;
	xwm->clip_len = len;
	xwm->cb.clipboard(xwm->data, text, len);
}

static void pull_start(struct xwm *xwm, xcb_atom_t target, xcb_timestamp_t time) {
	free(xwm->pull.buf);
	memset(&xwm->pull, 0, sizeof xwm->pull);
	xwm->pull.active = true;
	xwm->pull.target = target;
	xwm->pull.time = time;
	/* A transfer abandoned halfway may have left a piece behind. */
	xcb_delete_property(xwm->conn, xwm->selection, xwm->atoms[ATOM_WD_SELECTION]);
	xcb_convert_selection(xwm->conn, xwm->selection, xwm->atoms[ATOM_CLIPBOARD],
		target, xwm->atoms[ATOM_WD_SELECTION], time);
}

/*
 * The property the owner wrote, taken and deleted in one request — the
 * deletion is what tells an INCR owner to send the next piece. Over CLIP_MAX
 * the rest is dropped but still consumed, so that the owner finishes rather
 * than waits on us.
 */
static void pull_read(struct xwm *xwm) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(xwm->conn,
		xcb_get_property(xwm->conn, 1, xwm->selection,
			xwm->atoms[ATOM_WD_SELECTION], XCB_GET_PROPERTY_TYPE_ANY, 0,
			CLIP_MAX / 4 + 1), NULL);
	if (!r) {
		pull_end(xwm, false);
		return;
	}
	if (r->type == xwm->atoms[ATOM_INCR]) {
		/* The value is only a size estimate; the text follows piecewise. */
		xwm->pull.incr = true;
		free(r);
		return;
	}
	size_t len = (size_t)xcb_get_property_value_length(r);
	if (r->bytes_after)
		xcb_delete_property(xwm->conn, xwm->selection, xwm->atoms[ATOM_WD_SELECTION]);
	if (r->format != 8) {
		free(r);
		pull_end(xwm, false);
		return;
	}
	if (xwm->pull.len < CLIP_MAX && len > 0) {
		size_t take = len < CLIP_MAX - xwm->pull.len ? len : CLIP_MAX - xwm->pull.len;
		if (xwm->pull.len + take + 1 > xwm->pull.cap) {
			size_t cap = xwm->pull.cap ? xwm->pull.cap : 4096;
			while (cap < xwm->pull.len + take + 1) cap *= 2;
			char *buf = realloc(xwm->pull.buf, cap);
			if (!buf) {
				free(r);
				pull_end(xwm, false);
				return;
			}
			xwm->pull.buf = buf;
			xwm->pull.cap = cap;
		}
		memcpy(xwm->pull.buf + xwm->pull.len, xcb_get_property_value(r), take);
		xwm->pull.len += take;
		xwm->pull.buf[xwm->pull.len] = '\0';
	}
	free(r);
	/* An INCR transfer ends with an empty piece; a plain one is one piece. */
	if (!xwm->pull.incr || len == 0) pull_end(xwm, true);
}

/*
 * The most that goes into a requestor's property at once. The request
 * itself is not the limit — Xwayland speaks BIG-REQUESTS, 16 MB — the
 * requestor is: Tk refuses any property over 400 kB with "selection
 * property too large" and quietly asks for STRING instead, so a 456 kB
 * paste arrived as Latin-1 with '?' for every em dash. GTK caps its own
 * pieces at 256 kB for the same reason, and that is the figure here.
 */
#define INCR_PIECE (256u * 1024)

/* Whether the requestor still listens for the pieces: our mask on its
 * window, which is ours alone — X keeps one per client. A window we manage
 * is already watched for its title. */
static void watch_requestor(struct xwm *xwm, xcb_window_t requestor, bool on) {
	uint32_t mask = on || find(xwm, requestor) ? XCB_EVENT_MASK_PROPERTY_CHANGE : 0;
	xcb_change_window_attributes(xwm->conn, requestor, XCB_CW_EVENT_MASK, &mask);
}

static void push_end(struct xwm *xwm) {
	if (!xwm->push.data) return;
	watch_requestor(xwm, xwm->push.requestor, false);
	free(xwm->push.data);
	memset(&xwm->push, 0, sizeof xwm->push);
}

/* The requestor deleted the property: it has the last piece, send the next.
 * An empty one says that was all. */
static void push_piece(struct xwm *xwm) {
	size_t n = xwm->push.len - xwm->push.at;
	if (n > INCR_PIECE) n = INCR_PIECE;
	xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, xwm->push.requestor,
		xwm->push.property, xwm->push.type, 8, (uint32_t)n,
		xwm->push.data + xwm->push.at);
	xwm->push.at += n;
	if (n == 0) push_end(xwm);
}

/*
 * An X client pastes: it names a target and a property on its window, and
 * we put the text there — whole when it fits a piece, else as an INCR
 * transfer the requestor drives by deleting each piece it has read.
 * Returns whether the property was written.
 */
static bool clipboard_answer(struct xwm *xwm, xcb_window_t to,
		xcb_atom_t property, xcb_atom_t target) {
	const xcb_atom_t *a = xwm->atoms;
	if (!xwm->clip) return false;
	if (target == a[ATOM_TARGETS]) {
		xcb_atom_t targets[] = {
			a[ATOM_TARGETS], a[ATOM_TIMESTAMP], a[ATOM_UTF8_STRING],
			a[ATOM_TEXT_PLAIN_UTF8], a[ATOM_TEXT], XCB_ATOM_STRING,
			a[ATOM_TEXT_PLAIN],
		};
		xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, to, property,
			XCB_ATOM_ATOM, 32, sizeof targets / sizeof targets[0], targets);
		return true;
	}
	if (target == a[ATOM_TIMESTAMP]) {
		xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, to, property,
			XCB_ATOM_INTEGER, 32, 1, &xwm->clip_time);
		return true;
	}
	bool utf8 = target == a[ATOM_UTF8_STRING] || target == a[ATOM_TEXT_PLAIN_UTF8] ||
		target == a[ATOM_TEXT];
	bool latin1 = target == XCB_ATOM_STRING || target == a[ATOM_TEXT_PLAIN];
	if (!utf8 && !latin1) return false;

	const char *data = xwm->clip;
	size_t len = xwm->clip_len;
	char *converted = NULL;
	if (latin1) {
		converted = utf8_to_latin1(xwm->clip, xwm->clip_len, &len);
		if (!converted) return false;
		data = converted;
	}
	/* TEXT means "a text type of your choosing", named by the type. */
	xcb_atom_t type = target == a[ATOM_TEXT] ? a[ATOM_UTF8_STRING] : target;
	if (len <= INCR_PIECE) {
		xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, to, property,
			type, 8, (uint32_t)len, data);
		free(converted);
		return true;
	}

	/* One INCR transfer at a time; a requestor that stopped deleting pieces
	 * holds the slot only for so long. */
	if (xwm->push.data && time(NULL) - xwm->push.started < 10) {
		free(converted);
		return false;
	}
	push_end(xwm);
	char *copy = converted ? converted : malloc(len);
	if (!copy) return false;
	if (!converted) memcpy(copy, data, len);
	xwm->push.requestor = to;
	xwm->push.property = property;
	xwm->push.type = type;
	xwm->push.data = copy;
	xwm->push.len = len;
	xwm->push.started = time(NULL);
	watch_requestor(xwm, to, true);
	/* The INCR value is the size to expect; the pieces follow its deletion. */
	uint32_t total = (uint32_t)len;
	xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, to, property,
		a[ATOM_INCR], 32, 1, &total);
	return true;
}

/* XFixesSelectionNotify, which libxcb-xfixes would name for us. */
struct xfixes_selection_notify {
	uint8_t response_type;
	uint8_t subtype;
	uint16_t sequence;
	xcb_window_t window;
	xcb_window_t owner;
	xcb_atom_t selection;
	xcb_timestamp_t timestamp;
	xcb_timestamp_t selection_timestamp;
	uint8_t pad[8];
};

static void handle_selection_owner(struct xwm *xwm,
		const struct xfixes_selection_notify *e) {
	if (e->selection != xwm->atoms[ATOM_CLIPBOARD]) return;
	if (e->owner == xwm->selection) {
		xwm->clip_owned = true;
		/* The TIMESTAMP target wants the server's time of the take-over,
		 * which is this and not the CurrentTime we asked with. */
		xwm->clip_time = e->selection_timestamp;
		return;
	}
	xwm->clip_owned = false;
	if (e->owner == XCB_WINDOW_NONE) {
		/* In X the clipboard dies with its owner — close the application
		 * you copied from and there is nothing to paste. The browser's does
		 * not, and every X client's text came through here, so it stays. */
		if (xwm->clip) own_clipboard(xwm);
		return;
	}
	/* An X client copied. Read it now rather than when someone pastes: the
	 * browser's clipboard is a value, not a promise. */
	pull_start(xwm, xwm->atoms[ATOM_UTF8_STRING], e->timestamp);
}

static void handle_event(struct xwm *xwm, xcb_generic_event_t *ev) {
	uint8_t type = ev->response_type & ~0x80;
	if (xwm->xfixes_event && type == xwm->xfixes_event) {
		handle_selection_owner(xwm, (const void *)ev);
		return;
	}
	switch (type) {
	case XCB_SELECTION_NOTIFY: {
		/* The answer to our ConvertSelection: where the text is, or that
		 * the owner has none in that form. */
		xcb_selection_notify_event_t *e = (void *)ev;
		if (e->requestor != xwm->selection || !xwm->pull.active) break;
		if (e->property == XCB_ATOM_NONE) {
			if (e->target == xwm->atoms[ATOM_UTF8_STRING])
				pull_start(xwm, XCB_ATOM_STRING, xwm->pull.time);
			else
				pull_end(xwm, false);
			break;
		}
		pull_read(xwm);
		break;
	}
	case XCB_SELECTION_REQUEST: {
		xcb_selection_request_event_t *e = (void *)ev;
		if (e->owner != xwm->selection) break;
		/* A client from before ICCCM 2 names no property; the target is. */
		xcb_atom_t property = e->property ? e->property : e->target;
		bool ok = e->selection == xwm->atoms[ATOM_CLIPBOARD] &&
			clipboard_answer(xwm, e->requestor, property, e->target);
		xcb_selection_notify_event_t n = {
			.response_type = XCB_SELECTION_NOTIFY,
			.time = e->time,
			.requestor = e->requestor,
			.selection = e->selection,
			.target = e->target,
			.property = ok ? property : XCB_ATOM_NONE,
		};
		xcb_send_event(xwm->conn, 0, e->requestor, XCB_EVENT_MASK_NO_EVENT,
			(const char *)&n);
		break;
	}
	case XCB_SELECTION_CLEAR: {
		/* An X client took over; XFixes says who, and the read starts
		 * there. */
		xcb_selection_clear_event_t *e = (void *)ev;
		if (e->selection == xwm->atoms[ATOM_CLIPBOARD]) xwm->clip_owned = false;
		break;
	}
	case XCB_CREATE_NOTIFY: {
		xcb_create_notify_event_t *e = (void *)ev;
		if (e->parent != xwm->screen->root || e->window == xwm->check ||
			e->window == xwm->selection)
			break;
		struct xwm_win *w = calloc(1, sizeof *w);
		if (!w) break;
		w->id = e->window;
		w->x = e->x;
		w->y = e->y;
		w->width = e->width;
		w->height = e->height;
		w->override_redirect = e->override_redirect;
		w->next = xwm->windows;
		xwm->windows = w;
		uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
		xcb_change_window_attributes(xwm->conn, w->id, XCB_CW_EVENT_MASK, &mask);
		break;
	}
	case XCB_DESTROY_NOTIFY: {
		xcb_destroy_notify_event_t *e = (void *)ev;
		if (!find(xwm, e->window)) break;
		xwm->cb.gone(xwm->data, e->window, true);
		forget(xwm, e->window);
		break;
	}
	case XCB_MAP_REQUEST: {
		xcb_map_request_event_t *e = (void *)ev;
		struct xwm_win *w = find(xwm, e->window);
		if (w) {
			read_title(xwm, w);
			read_class(xwm, w);
			read_transient_for(xwm, w);
			read_hints(xwm, w);
			/* Every managed window lives at the origin, borderless: the
			 * output is the window, and the shell draws the frame. */
			uint32_t at[3] = {0, 0, 0};
			xcb_configure_window(xwm->conn, w->id,
				XCB_CONFIG_WINDOW_X | XCB_CONFIG_WINDOW_Y |
				XCB_CONFIG_WINDOW_BORDER_WIDTH, at);
			/* ICCCM NormalState; some toolkits wait for it before drawing. */
			uint32_t state[2] = {1, XCB_WINDOW_NONE};
			xcb_change_property(xwm->conn, XCB_PROP_MODE_REPLACE, w->id,
				xwm->atoms[ATOM_WM_STATE], xwm->atoms[ATOM_WM_STATE], 32, 2,
				state);
		}
		xcb_map_window(xwm->conn, e->window);
		break;
	}
	case XCB_MAP_NOTIFY: {
		xcb_map_notify_event_t *e = (void *)ev;
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		w->mapped = true;
		/*
		 * The flag at map time, not at creation. Tk creates a menu as an
		 * ordinary window and sets override-redirect on it afterwards, and
		 * no event reports that change — so every Tk menu arrived here
		 * looking like a toplevel, and the shell gave each a window of its
		 * own. The map is what makes the difference visible: an
		 * override-redirect window maps without asking, and the server
		 * says so in the notification.
		 */
		w->override_redirect = e->override_redirect;
		/* No MapRequest came for it, so nothing has been read yet. The
		 * transient hint is the one thing a menu can say about whose it
		 * is, and GTK and Qt set it. */
		if (w->override_redirect) {
			if (!w->title) read_title(xwm, w);
			read_transient_for(xwm, w);
		}
		report_surface(xwm, w);
		break;
	}
	case XCB_UNMAP_NOTIFY: {
		xcb_unmap_notify_event_t *e = (void *)ev;
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		w->mapped = false;
		/* Xwayland drops the surface with the mapping and names a new one
		 * when the window comes back. */
		w->surface_id = 0;
		xwm->cb.gone(xwm->data, w->id, false);
		break;
	}
	case XCB_CONFIGURE_REQUEST: {
		xcb_configure_request_event_t *e = (void *)ev;
		struct xwm_win *w = find(xwm, e->window);
		uint32_t values[7];
		uint16_t mask = 0;
		int n = 0;
		/* A managed window stays at the origin, whatever it asks for. */
		if (e->value_mask & XCB_CONFIG_WINDOW_X) {
			mask |= XCB_CONFIG_WINDOW_X;
			values[n++] = w && !w->override_redirect ? 0 : (uint32_t)e->x;
		}
		if (e->value_mask & XCB_CONFIG_WINDOW_Y) {
			mask |= XCB_CONFIG_WINDOW_Y;
			values[n++] = w && !w->override_redirect ? 0 : (uint32_t)e->y;
		}
		if (e->value_mask & XCB_CONFIG_WINDOW_WIDTH) {
			mask |= XCB_CONFIG_WINDOW_WIDTH;
			values[n++] = e->width;
		}
		if (e->value_mask & XCB_CONFIG_WINDOW_HEIGHT) {
			mask |= XCB_CONFIG_WINDOW_HEIGHT;
			values[n++] = e->height;
		}
		if (e->value_mask & XCB_CONFIG_WINDOW_BORDER_WIDTH) {
			mask |= XCB_CONFIG_WINDOW_BORDER_WIDTH;
			values[n++] = 0;
		}
		if (mask) xcb_configure_window(xwm->conn, e->window, mask, values);
		/*
		 * ICCCM 4.1.5: the client is told where it ended up, synthetically
		 * if need be. Xt waits for exactly this after every request, and a
		 * window manager that stays silent costs each window its wmTimeout
		 * — five seconds before xmessage drew anything.
		 */
		if (w) {
			xcb_get_geometry_reply_t *g = xcb_get_geometry_reply(xwm->conn,
				xcb_get_geometry(xwm->conn, e->window), NULL);
			if (g) {
				xcb_configure_notify_event_t n = {
					.response_type = XCB_CONFIGURE_NOTIFY,
					.event = e->window,
					.window = e->window,
					.x = g->x,
					.y = g->y,
					.width = g->width,
					.height = g->height,
				};
				xcb_send_event(xwm->conn, 0, e->window,
					XCB_EVENT_MASK_STRUCTURE_NOTIFY, (const char *)&n);
				free(g);
			}
		}
		break;
	}
	case XCB_CONFIGURE_NOTIFY: {
		xcb_configure_notify_event_t *e = (void *)ev;
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		bool changed = w->width != e->width || w->height != e->height ||
			w->x != e->x || w->y != e->y;
		w->x = e->x;
		w->y = e->y;
		w->width = e->width;
		w->height = e->height;
		if (changed && w->surface_id && w->mapped)
			xwm->cb.geometry(xwm->data, w->id, w->x, w->y, w->width, w->height);
		break;
	}
	case XCB_PROPERTY_NOTIFY: {
		xcb_property_notify_event_t *e = (void *)ev;
		if (xwm->push.data && e->window == xwm->push.requestor &&
			e->atom == xwm->push.property) {
			if (e->state == XCB_PROPERTY_DELETE) push_piece(xwm);
			break;
		}
		if (e->window == xwm->selection) {
			/* The owner wrote the next INCR piece. */
			if (xwm->pull.active && xwm->pull.incr &&
				e->atom == xwm->atoms[ATOM_WD_SELECTION] &&
				e->state == XCB_PROPERTY_NEW_VALUE)
				pull_read(xwm);
			break;
		}
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		if (e->atom == xwm->atoms[ATOM_NET_WM_NAME] || e->atom == XCB_ATOM_WM_NAME) {
			read_title(xwm, w);
			if (w->surface_id && w->mapped)
				xwm->cb.title(xwm->data, w->id, w->title);
		} else if (e->atom == XCB_ATOM_WM_NORMAL_HINTS) {
			read_hints(xwm, w);
			if (w->surface_id && w->mapped)
				xwm->cb.bounds(xwm->data, w->id, w->min_width, w->min_height,
					w->max_width, w->max_height);
		}
		break;
	}
	case XCB_CLIENT_MESSAGE: {
		xcb_client_message_event_t *e = (void *)ev;
		if (e->type != xwm->atoms[ATOM_WL_SURFACE_ID]) break;
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		w->surface_id = e->data.data32[0];
		report_surface(xwm, w);
		break;
	}
	default:
		break;
	}
}

/*
 * Extension requests by hand. Each is a handful of bytes, and libxcb fills
 * in the opcodes and the length; that is not worth a library per extension
 * (libxcb-composite, libxcb-xfixes) that a bare server would have to grow.
 */
static void send_extension_request(xcb_connection_t *conn, xcb_extension_t *ext,
		uint8_t opcode, bool has_reply, void *req, size_t size) {
	xcb_protocol_request_t proto = {
		.count = 2, .ext = ext, .opcode = opcode, .isvoid = !has_reply,
	};
	struct iovec parts[4] = {
		[2] = {.iov_base = req, .iov_len = size},
		[3] = {.iov_base = NULL, .iov_len = 0},
	};
	unsigned seq = xcb_send_request(conn, 0, parts + 2, &proto);
	if (has_reply) xcb_discard_reply(conn, seq);
}

/*
 * Composite's RedirectSubwindows. Rootless Xwayland gives a window a
 * wl_surface only when it is redirected — without this every window maps
 * and nothing is ever drawn.
 */
static void redirect_subwindows(xcb_connection_t *conn, xcb_window_t root) {
	static xcb_extension_t composite = {"Composite", 0};
	struct {
		uint8_t major, minor;
		uint16_t length;
		uint32_t window;
		uint8_t update, pad[3];
	} req = {.window = root, .update = 1 /* Manual */};
	send_extension_request(conn, &composite, 2, false, &req, sizeof req);
}

/*
 * XFixes' SelectSelectionInput: the server tells us when CLIPBOARD changes
 * hands, which is the only alternative to polling GetSelectionOwner. The
 * version handshake first is not a courtesy — the server answers BadRequest
 * to anything else from a client that has not made it. Returns the
 * extension's first event code, 0 if the server has no XFixes.
 */
static uint8_t watch_clipboard(xcb_connection_t *conn, xcb_window_t window,
		xcb_atom_t clipboard) {
	static xcb_extension_t xfixes = {"XFIXES", 0};
	const xcb_query_extension_reply_t *ext = xcb_get_extension_data(conn, &xfixes);
	if (!ext || !ext->present) return 0;
	struct {
		uint8_t major, minor;
		uint16_t length;
		uint32_t client_major, client_minor;
	} version = {.client_major = 5, .client_minor = 0};
	send_extension_request(conn, &xfixes, 0, true, &version, sizeof version);
	struct {
		uint8_t major, minor;
		uint16_t length;
		xcb_window_t window;
		xcb_atom_t selection;
		uint32_t event_mask;
	} select = {
		.window = window, .selection = clipboard,
		/* SetSelectionOwner | SelectionWindowDestroy | SelectionClientClose */
		.event_mask = 1 | 2 | 4,
	};
	send_extension_request(conn, &xfixes, 2, false, &select, sizeof select);
	return ext->first_event;
}

struct xwm *xwm_create(int fd, const struct xwm_callbacks *cb, void *data) {
	xcb_connection_t *conn = xcb_connect_to_fd(fd, NULL);
	if (xcb_connection_has_error(conn)) {
		xcb_disconnect(conn);
		return NULL;
	}
	struct xwm *xwm = calloc(1, sizeof *xwm);
	if (!xwm) {
		xcb_disconnect(conn);
		return NULL;
	}
	xwm->conn = conn;
	xwm->cb = *cb;
	xwm->data = data;
	xwm->screen = xcb_setup_roots_iterator(xcb_get_setup(conn)).data;

	xcb_intern_atom_cookie_t cookies[ATOM_COUNT];
	for (int i = 0; i < ATOM_COUNT; i++)
		cookies[i] = xcb_intern_atom(conn, 0, (uint16_t)strlen(atom_names[i]),
			atom_names[i]);
	for (int i = 0; i < ATOM_COUNT; i++) {
		xcb_intern_atom_reply_t *r = xcb_intern_atom_reply(conn, cookies[i], NULL);
		xwm->atoms[i] = r ? r->atom : XCB_ATOM_NONE;
		free(r);
	}

	xcb_window_t root = xwm->screen->root;
	uint32_t mask = XCB_EVENT_MASK_SUBSTRUCTURE_REDIRECT |
		XCB_EVENT_MASK_SUBSTRUCTURE_NOTIFY | XCB_EVENT_MASK_PROPERTY_CHANGE;
	xcb_generic_error_t *err = xcb_request_check(conn,
		xcb_change_window_attributes_checked(conn, root, XCB_CW_EVENT_MASK, &mask));
	if (err) {
		fprintf(stderr, "wdcomp: xwm: another window manager owns the root\n");
		free(err);
		xwm_destroy(xwm);
		return NULL;
	}

	redirect_subwindows(conn, root);

	/* Toolkits look for a window manager before trusting one is there. */
	xwm->check = xcb_generate_id(conn);
	xcb_create_window(conn, XCB_COPY_FROM_PARENT, xwm->check, root, 0, 0, 1, 1,
		0, XCB_WINDOW_CLASS_INPUT_OUTPUT, xwm->screen->root_visual, 0, NULL);
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, root,
		xwm->atoms[ATOM_NET_SUPPORTING_WM_CHECK], XCB_ATOM_WINDOW, 32, 1,
		&xwm->check);
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, xwm->check,
		xwm->atoms[ATOM_NET_SUPPORTING_WM_CHECK], XCB_ATOM_WINDOW, 32, 1,
		&xwm->check);
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, xwm->check,
		xwm->atoms[ATOM_NET_WM_NAME], xwm->atoms[ATOM_UTF8_STRING], 8, 6,
		"wdcomp");
	/*
	 * The ICCCM window manager selection, and not for form's sake: given
	 * -wm together with -listenfd, Xwayland does not accept a client on
	 * the display's sockets until some window manager owns WM_S0 — the
	 * first X client sat in the socket's backlog for ever, with the server
	 * up and nothing in any log. The selection is the signal it waits on.
	 */
	xcb_set_selection_owner(conn, xwm->check, xwm->atoms[ATOM_WM_S0],
		XCB_CURRENT_TIME);

	/*
	 * A window that defines no cursor shows the root window's, and a
	 * rootless Xwayland's root has none until a window manager gives it
	 * one — desktop window managers all do. Without it, Xwayland tells the
	 * compositor "no cursor" (wl_pointer.set_cursor with a null surface,
	 * the Wayland way of hiding the pointer) whenever the pointer enters
	 * such a window, and the browser's arrow vanished over every Tk and
	 * SDL window, while xfontsel, which sets cursors of its own, was fine.
	 * Which cursor hardly matters: the compositor never draws an X cursor
	 * image, it only passes "there is one" on to the browser as its default
	 * arrow. The old cursor font needs no theme and is always present.
	 */
	xwm->cursor_font = xcb_generate_id(conn);
	xcb_open_font(conn, xwm->cursor_font, 6, "cursor");
	xwm->root_cursor = xcb_generate_id(conn);
	/* Glyph 68 is XC_left_ptr; the next glyph is its mask. */
	xcb_create_glyph_cursor(conn, xwm->root_cursor, xwm->cursor_font,
		xwm->cursor_font, 68, 69, 0, 0, 0, 0xffff, 0xffff, 0xffff);
	xcb_change_window_attributes(conn, root, XCB_CW_CURSOR, &xwm->root_cursor);

	/* The clipboard window: its property changes are the INCR pieces. */
	xwm->selection = xcb_generate_id(conn);
	uint32_t property_change = XCB_EVENT_MASK_PROPERTY_CHANGE;
	xcb_create_window(conn, XCB_COPY_FROM_PARENT, xwm->selection, root, 0, 0,
		1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT, xwm->screen->root_visual,
		XCB_CW_EVENT_MASK, &property_change);
	xwm->xfixes_event = watch_clipboard(conn, xwm->selection,
		xwm->atoms[ATOM_CLIPBOARD]);
	if (!xwm->xfixes_event)
		fprintf(stderr, "wdcomp: xwm: no XFixes; copying out of X clients is off\n");
	xcb_flush(conn);
	return xwm;
}

int xwm_get_fd(struct xwm *xwm) {
	return xcb_get_file_descriptor(xwm->conn);
}

int xwm_dispatch(struct xwm *xwm) {
	xcb_generic_event_t *ev;
	while ((ev = xcb_poll_for_event(xwm->conn))) {
		handle_event(xwm, ev);
		free(ev);
	}
	xcb_flush(xwm->conn);
	return xcb_connection_has_error(xwm->conn) ? -1 : 0;
}

void xwm_configure(struct xwm *xwm, uint32_t xwin, int32_t width, int32_t height) {
	uint32_t size[2] = {(uint32_t)width, (uint32_t)height};
	xcb_configure_window(xwm->conn, xwin,
		XCB_CONFIG_WINDOW_WIDTH | XCB_CONFIG_WINDOW_HEIGHT, size);
	xcb_flush(xwm->conn);
}

void xwm_close(struct xwm *xwm, uint32_t xwin) {
	if (supports(xwm, xwin, xwm->atoms[ATOM_WM_DELETE_WINDOW]))
		send_protocol(xwm, xwin, xwm->atoms[ATOM_WM_DELETE_WINDOW]);
	else
		xcb_kill_client(xwm->conn, xwin);
	xcb_flush(xwm->conn);
}

void xwm_focus(struct xwm *xwm, uint32_t xwin) {
	xcb_set_input_focus(xwm->conn, XCB_INPUT_FOCUS_POINTER_ROOT, xwin,
		XCB_CURRENT_TIME);
	if (supports(xwm, xwin, xwm->atoms[ATOM_WM_TAKE_FOCUS]))
		send_protocol(xwm, xwin, xwm->atoms[ATOM_WM_TAKE_FOCUS]);
	xcb_flush(xwm->conn);
}

void xwm_set_clipboard(struct xwm *xwm, const char *text, size_t len) {
	char *copy = malloc(len + 1);
	if (!copy) return;
	memcpy(copy, text, len);
	copy[len] = '\0';
	free(xwm->clip);
	xwm->clip = copy;
	xwm->clip_len = len;
	/* Newer than whatever an X client was in the middle of handing over. */
	if (xwm->pull.active) pull_end(xwm, false);
	if (!xwm->clip_owned) own_clipboard(xwm);
	xcb_flush(xwm->conn);
}

void xwm_destroy(struct xwm *xwm) {
	if (!xwm) return;
	while (xwm->windows) forget(xwm, xwm->windows->id);
	free(xwm->clip);
	free(xwm->pull.buf);
	free(xwm->push.data);
	if (xwm->root_cursor) xcb_free_cursor(xwm->conn, xwm->root_cursor);
	if (xwm->cursor_font) xcb_close_font(xwm->conn, xwm->cursor_font);
	xcb_disconnect(xwm->conn);
	free(xwm);
}
