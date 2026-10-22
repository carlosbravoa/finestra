/*
 * xwm — see xwm.h.
 *
 * Spike scope (ROADMAP.md, Xwayland phase 0): pair X windows with their
 * wl_surface, map what asks to be mapped, pass on titles and sizes, close
 * politely. Override-redirect windows are reported as such and wdcomp shows
 * them as popups. No decorations, ever: the shell draws the frame.
 */
#include "xwm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
};

struct xwm_win {
	xcb_window_t id;
	int32_t x, y, width, height;
	bool override_redirect;
	bool mapped;
	uint32_t surface_id;
	char *title;
	char *app_id;
	struct xwm_win *next;
};

struct xwm {
	xcb_connection_t *conn;
	xcb_screen_t *screen;
	xcb_window_t check;
	xcb_atom_t atoms[ATOM_COUNT];
	struct xwm_callbacks cb;
	void *data;
	struct xwm_win *windows;
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
	};
	xwm->cb.surface(xwm->data, &info, w->surface_id);
}

static void handle_event(struct xwm *xwm, xcb_generic_event_t *ev) {
	switch (ev->response_type & ~0x80) {
	case XCB_CREATE_NOTIFY: {
		xcb_create_notify_event_t *e = (void *)ev;
		if (e->parent != xwm->screen->root || e->window == xwm->check) break;
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
		if (w->override_redirect && !w->title) read_title(xwm, w);
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
		struct xwm_win *w = find(xwm, e->window);
		if (!w) break;
		if (e->atom == xwm->atoms[ATOM_NET_WM_NAME] || e->atom == XCB_ATOM_WM_NAME) {
			read_title(xwm, w);
			if (w->surface_id && w->mapped)
				xwm->cb.title(xwm->data, w->id, w->title);
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
 * Composite's RedirectSubwindows, by hand. Rootless Xwayland gives a window
 * a wl_surface only when it is redirected — without this every window maps
 * and nothing is ever drawn — and the request is twelve bytes, which is not
 * worth a library (libxcb-composite) that a bare server would have to grow.
 */
static void redirect_subwindows(xcb_connection_t *conn, xcb_window_t root) {
	static xcb_extension_t composite = {"Composite", 0};
	struct {
		uint8_t major, minor;
		uint16_t length;
		uint32_t window;
		uint8_t update, pad[3];
	} req = {.window = root, .update = 1 /* Manual */};
	xcb_protocol_request_t proto = {
		.count = 2, .ext = &composite, .opcode = 2, .isvoid = 1,
	};
	struct iovec parts[4] = {
		[2] = {.iov_base = &req, .iov_len = sizeof req},
		[3] = {.iov_base = NULL, .iov_len = 0},
	};
	xcb_send_request(conn, 0, parts + 2, &proto);
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

void xwm_destroy(struct xwm *xwm) {
	if (!xwm) return;
	while (xwm->windows) forget(xwm, xwm->windows->id);
	xcb_disconnect(xwm->conn);
	free(xwm);
}
