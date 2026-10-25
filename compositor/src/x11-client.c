/*
 * An X11 client for the test suite, in the shape the window manager has to
 * handle: a toplevel with a name and a class, a menu (override-redirect) over
 * it, a dialog (transient) belonging to it, the clipboard owned and the
 * clipboard asked for, and WM_DELETE_WINDOW honoured. Launched through the
 * service like any application, under the DISPLAY the compositor sets, so
 * what it exercises is the whole path — the lazily started Xwayland
 * included — rather than the window manager on its own.
 *
 * Reports go to files named by the environment, as subsurface-client's do:
 * WD_TEST_XPOINTER gets where the pointer entered, WD_TEST_XPASTE what a
 * paste produced. Everything is xcb; no toolkit, so there is nothing between
 * the suite and the protocol.
 */
#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <xcb/xcb.h>

#define COPY_TEXT "from-x \xc3\xb1\xe2\x82\xac" /* "from-x ñ€" */

static xcb_connection_t *conn;
static xcb_screen_t *screen;
static xcb_window_t main_win, popup_win, dialog_win;
static xcb_atom_t WM_PROTOCOLS, WM_DELETE_WINDOW, NET_WM_NAME, UTF8_STRING,
	CLIPBOARD, TARGETS, WD_FIXTURE;

static bool want_popup, want_dialog, want_copy, want_paste;
static long linger_ms = -1;

static xcb_atom_t atom(const char *name) {
	xcb_intern_atom_reply_t *r = xcb_intern_atom_reply(conn,
		xcb_intern_atom(conn, 0, (uint16_t)strlen(name), name), NULL);
	xcb_atom_t a = r ? r->atom : XCB_ATOM_NONE;
	free(r);
	return a;
}

static uint64_t now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

static void write_report(const char *env, const char *text) {
	const char *path = getenv(env);
	if (!path) return;
	FILE *f = fopen(path, "w");
	if (!f) return;
	fputs(text, f);
	fclose(f);
}

static xcb_window_t make_window(xcb_window_t parent, int16_t x, int16_t y,
		uint16_t w, uint16_t h, uint32_t pixel, bool override) {
	xcb_window_t win = xcb_generate_id(conn);
	uint32_t values[3] = {pixel, override ? 1 : 0,
		XCB_EVENT_MASK_EXPOSURE | XCB_EVENT_MASK_STRUCTURE_NOTIFY |
		XCB_EVENT_MASK_ENTER_WINDOW | XCB_EVENT_MASK_POINTER_MOTION |
		XCB_EVENT_MASK_BUTTON_PRESS | XCB_EVENT_MASK_PROPERTY_CHANGE};
	xcb_create_window(conn, XCB_COPY_FROM_PARENT, win, parent, x, y, w, h, 0,
		XCB_WINDOW_CLASS_INPUT_OUTPUT, screen->root_visual,
		XCB_CW_BACK_PIXEL | XCB_CW_OVERRIDE_REDIRECT | XCB_CW_EVENT_MASK,
		values);
	return win;
}

static void set_name(xcb_window_t win, const char *name) {
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, win, XCB_ATOM_WM_NAME,
		XCB_ATOM_STRING, 8, (uint32_t)strlen(name), name);
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, win, NET_WM_NAME,
		UTF8_STRING, 8, (uint32_t)strlen(name), name);
}

/* The clipboard, answered the way a toolkit answers: TARGETS, then the text
 * in whichever of the two string types was asked for. */
static void answer_selection(xcb_selection_request_event_t *e) {
	xcb_atom_t property = e->property ? e->property : e->target;
	bool ok = true;
	if (e->selection != CLIPBOARD) {
		ok = false;
	} else if (e->target == TARGETS) {
		xcb_atom_t targets[3] = {TARGETS, UTF8_STRING, XCB_ATOM_STRING};
		xcb_change_property(conn, XCB_PROP_MODE_REPLACE, e->requestor, property,
			XCB_ATOM_ATOM, 32, 3, targets);
	} else if (e->target == UTF8_STRING || e->target == XCB_ATOM_STRING) {
		xcb_change_property(conn, XCB_PROP_MODE_REPLACE, e->requestor, property,
			e->target, 8, (uint32_t)strlen(COPY_TEXT), COPY_TEXT);
	} else {
		ok = false;
	}
	xcb_selection_notify_event_t n = {
		.response_type = XCB_SELECTION_NOTIFY,
		.time = e->time,
		.requestor = e->requestor,
		.selection = e->selection,
		.target = e->target,
		.property = ok ? property : XCB_ATOM_NONE,
	};
	xcb_send_event(conn, 0, e->requestor, XCB_EVENT_MASK_NO_EVENT,
		(const char *)&n);
}

/* A paste that arrived: read it out and report it; an empty answer or a
 * refusal means nobody has pasted yet, and the next request goes out later. */
static bool read_paste(void) {
	xcb_get_property_reply_t *r = xcb_get_property_reply(conn,
		xcb_get_property(conn, 1, main_win, WD_FIXTURE, XCB_GET_PROPERTY_TYPE_ANY,
			0, 1 << 16), NULL);
	if (!r) return false;
	int len = xcb_get_property_value_length(r);
	bool got = len > 0;
	if (got) {
		char *text = malloc((size_t)len + 1);
		if (text) {
			memcpy(text, xcb_get_property_value(r), (size_t)len);
			text[len] = '\0';
			write_report("WD_TEST_XPASTE", text);
			free(text);
		}
	}
	free(r);
	return got;
}

int main(int argc, char **argv) {
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--popup") == 0) want_popup = true;
		else if (strcmp(argv[i], "--dialog") == 0) want_dialog = true;
		else if (strcmp(argv[i], "--copy") == 0) want_copy = true;
		else if (strcmp(argv[i], "--paste") == 0) want_paste = true;
		else if (strcmp(argv[i], "--linger") == 0 && i + 1 < argc) linger_ms = atol(argv[++i]);
		else {
			fprintf(stderr, "usage: x11-client [--popup] [--dialog] [--copy] [--paste] [--linger MS]\n");
			return 2;
		}
	}

	int screen_no = 0;
	conn = xcb_connect(NULL, &screen_no);
	if (!conn || xcb_connection_has_error(conn)) {
		fprintf(stderr, "x11-client: cannot open display %s\n",
			getenv("DISPLAY") ? getenv("DISPLAY") : "(unset)");
		return 1;
	}
	xcb_screen_iterator_t it = xcb_setup_roots_iterator(xcb_get_setup(conn));
	for (int i = 0; i < screen_no; i++) xcb_screen_next(&it);
	screen = it.data;

	WM_PROTOCOLS = atom("WM_PROTOCOLS");
	WM_DELETE_WINDOW = atom("WM_DELETE_WINDOW");
	NET_WM_NAME = atom("_NET_WM_NAME");
	UTF8_STRING = atom("UTF8_STRING");
	CLIPBOARD = atom("CLIPBOARD");
	TARGETS = atom("TARGETS");
	WD_FIXTURE = atom("_WD_FIXTURE");

	main_win = make_window(screen->root, 0, 0, 320, 240, 0x3366cc, false);
	set_name(main_win, "X Fixture");
	static const char wm_class[] = "x11-client\0WDX11Fixture";
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, main_win, XCB_ATOM_WM_CLASS,
		XCB_ATOM_STRING, 8, sizeof wm_class, wm_class);
	xcb_change_property(conn, XCB_PROP_MODE_REPLACE, main_win, WM_PROTOCOLS,
		XCB_ATOM_ATOM, 32, 1, &WM_DELETE_WINDOW);
	xcb_map_window(conn, main_win);
	xcb_flush(conn);

	bool mapped = false, running = true;
	uint64_t mapped_at = 0, next_paste = 0;
	struct pollfd pfd = {.fd = xcb_get_file_descriptor(conn), .events = POLLIN};
	while (running) {
		xcb_flush(conn);
		poll(&pfd, 1, 50);
		if (xcb_connection_has_error(conn)) {
			fprintf(stderr, "x11-client: the display went away\n");
			return 1;
		}
		uint64_t now = now_ms();
		if (mapped && linger_ms >= 0 && now >= mapped_at + (uint64_t)linger_ms) {
			/* Leaving the way an application does: windows destroyed, then
			 * the connection closed. */
			xcb_destroy_window(conn, main_win);
			break;
		}
		if (mapped && want_paste && now >= next_paste) {
			xcb_delete_property(conn, main_win, WD_FIXTURE);
			xcb_convert_selection(conn, main_win, CLIPBOARD, UTF8_STRING,
				WD_FIXTURE, XCB_CURRENT_TIME);
			next_paste = now + 250;
		}
		xcb_generic_event_t *ev;
		while ((ev = xcb_poll_for_event(conn))) {
			switch (ev->response_type & 0x7f) {
			case XCB_MAP_NOTIFY: {
				xcb_map_notify_event_t *e = (void *)ev;
				if (e->window != main_win || mapped) break;
				mapped = true;
				mapped_at = now_ms();
				/* Everything that belongs to the window waits for it to be up:
				 * a menu over a window not yet shown has nothing to be over. */
				if (want_popup) {
					popup_win = make_window(screen->root, 40, 30, 100, 60, 0xffcc00, true);
					xcb_map_window(conn, popup_win);
				}
				if (want_dialog) {
					dialog_win = make_window(screen->root, 0, 0, 200, 100, 0xcc3333, false);
					set_name(dialog_win, "X Dialog");
					xcb_change_property(conn, XCB_PROP_MODE_REPLACE, dialog_win,
						XCB_ATOM_WM_TRANSIENT_FOR, XCB_ATOM_WINDOW, 32, 1, &main_win);
					xcb_map_window(conn, dialog_win);
				}
				if (want_copy)
					xcb_set_selection_owner(conn, main_win, CLIPBOARD, XCB_CURRENT_TIME);
				break;
			}
			case XCB_ENTER_NOTIFY: {
				xcb_enter_notify_event_t *e = (void *)ev;
				if (e->event != main_win) break;
				char line[64];
				snprintf(line, sizeof line, "window %d %d", e->event_x, e->event_y);
				write_report("WD_TEST_XPOINTER", line);
				break;
			}
			case XCB_SELECTION_REQUEST:
				answer_selection((xcb_selection_request_event_t *)ev);
				break;
			case XCB_SELECTION_NOTIFY: {
				xcb_selection_notify_event_t *e = (void *)ev;
				if (e->property != XCB_ATOM_NONE && read_paste()) want_paste = false;
				break;
			}
			case XCB_CLIENT_MESSAGE: {
				xcb_client_message_event_t *e = (void *)ev;
				if (e->type == WM_PROTOCOLS && e->data.data32[0] == WM_DELETE_WINDOW) {
					xcb_destroy_window(conn, e->window);
					if (e->window == main_win) running = false;
				}
				break;
			}
			case XCB_DESTROY_NOTIFY: {
				xcb_destroy_notify_event_t *e = (void *)ev;
				if (e->window == main_win) running = false;
				break;
			}
			default:
				break;
			}
			free(ev);
		}
	}
	xcb_flush(conn);
	xcb_disconnect(conn);
	return 0;
}
