/*
 * wdcomp — the web-desktop compositor.
 *
 * A headless Wayland compositor that accepts real applications and takes the
 * pixels they render. There is no output device and no GPU: a client hands
 * over a shm buffer and a damage rectangle, and that is all we need.
 *
 * Two sinks. With --ipc, damaged rectangles are deflated and streamed to the
 * node server over fd 3, which is how they reach a canvas in the browser.
 * Without it, each commit is written to a PNG — no browser required, which is
 * how this is debugged. See docs/wayland.md.
 *
 * What is implemented: wl_compositor, wl_shm (by libwayland), wl_output,
 * wl_seat with a pointer and an xkb keyboard, wl_subcompositor and
 * wl_data_device_manager as stubs, and xdg_wm_base with toplevel and popup
 * roles.
 *
 * What is not: dmabuf, popup rendering, subsurface composition, decorations,
 * clipboard. Those are stages 6, 4, 6, 4 and 5.
 */

#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <sys/mman.h>
#include <xkbcommon/xkbcommon.h>
#include <zlib.h>

#include <linux/input-event-codes.h>

#include <wayland-server-core.h>
#include <wayland-server-protocol.h>

#include "cursor-shape-v1-server-protocol.h"
#include "xdg-shell-server-protocol.h"

#include "ipc.h"
#include "png.h"

#define WDC_SEAT_NAME "seat0"
/* Shape 0 is unused by the protocol, so it can mean "no cursor at all". */
#define WDC_CURSOR_HIDDEN 0
/* The frame channel. stdout is shared with the application and the bus. */
#define WDC_IPC_FD 3
#define WDC_MAX_DAMAGE 32

struct wdc_server;

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

static bool wdc_verbose = false;

static void logmsg(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "wdcomp: ");
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
}

static void logdbg(const char *fmt, ...) {
	if (!wdc_verbose) return;
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "wdcomp: ");
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
}

static uint32_t now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

struct wdc_rect {
	int32_t x, y, width, height;
};

/*
 * One seat: the pointer and keyboard the browser drives.
 *
 * Clients translate keycodes themselves through the xkb keymap we hand them,
 * so what travels is *physical keys* — evdev codes — not characters. The
 * modifier state is derived here from an xkb_state rather than trusted from
 * the browser, which is both more correct and one less thing to validate.
 */
struct wdc_seat {
	struct wl_list pointers;  /* wl_resource links */
	struct wl_list keyboards; /* wl_resource links */

	struct xkb_context *xkb;
	struct xkb_keymap *keymap;
	struct xkb_state *xkb_state;
	char *keymap_string;
	size_t keymap_size;

	struct wdc_surface *pointer_focus;
	struct wdc_surface *keyboard_focus;
	/* The cursor the application last asked for; resending an unchanged one
	 * on every motion would be a message per mouse move. */
	uint32_t cursor_shape;

	/* Clipboard. `offered` is what the browser has and the application may
	 * ask for; the other direction is read out of the application's own
	 * data source when it announces a selection. */
	struct wl_list data_devices; /* wl_resource links */
	/* Exactly one of these owns the clipboard: the application's own source,
	 * or the text the browser gave us. */
	struct wl_resource *selection_source;
	char *offered;
	struct wl_event_source *offer_timer;
	/* evdev keycodes currently held, so focus changes can release them. */
	struct wl_array pressed;
};

struct wdc_server {
	struct wl_display *display;
	struct wl_event_loop *loop;
	struct wdc_seat seat;

	/* The size we configure toplevels to; stands in for a shell window. */
	int32_t width, height;

	/*
	 * What we tell applications the display's pixel density is, and the only
	 * reason their text can be sharp. A browser on a HiDPI screen draws our
	 * frames into a box whose device pixels outnumber them; advertising 1 here
	 * meant every toolkit laid out for 1x and the browser magnified the result,
	 * which is not blur but something worse on text — nearest-neighbour
	 * doubling, uneven at fractional ratios. GTK reads this, sets its buffer
	 * scale to match, and draws at the density the screen actually has.
	 */
	int32_t scale;

	/* Stage 1 sink: PNGs on disk. Stage 2 sink: framed IPC to the server. */
	const char *outdir;
	int max_frames;
	int frames_written;
	struct ipc *ipc;

	bool running;
	pid_t child;

	uint32_t serial;
	uint32_t next_window_id;
	struct wl_list windows; /* every xdg_surface, whatever its role */
	struct wl_list popups;  /* most recent first, for grab lookup */
};

struct wdc_toplevel;
struct wdc_popup;

/* A wl_surface, with whatever xdg role has been attached to it. */
struct wdc_surface {
	struct wl_resource *resource;
	struct wdc_server *server;

	/* Pending (double-buffered) state, applied on commit. */
	struct wl_resource *pending_buffer;
	bool pending_buffer_set;
	struct wl_listener pending_buffer_destroy;
	struct wl_list pending_frames; /* wl_resource links, wl_callback */
	struct wdc_rect damage[WDC_MAX_DAMAGE];
	int damage_count;
	bool damage_overflow;
	int32_t pending_scale;

	/* Current state. */
	int32_t scale;

	/*
	 * Frame pacing. A client will not draw again until its frame callback
	 * fires, so holding them until the browser has acknowledged the last
	 * frame is what stops a fast application outrunning the socket.
	 */
	bool awaiting_ack;
	uint32_t frame_sent_ms;

	struct wdc_xdg_surface *xdg;
};

/*
 * An xdg_surface is the thing the shell thinks of as a window, whichever role
 * it ends up with: a toplevel is a window, and so is a popup — a menu is just
 * a window that happens to be positioned against another one.
 */
struct wdc_xdg_surface {
	struct wl_resource *resource;
	struct wdc_surface *surface;
	struct wdc_toplevel *toplevel;
	struct wdc_popup *popup;
	struct wl_list link; /* wdc_server.windows */

	uint32_t id;
	bool announced;

	bool initial_configure_sent;
	uint32_t last_acked;

	/* The size this window is configured at, and the size last sent, so a
	 * resize can force a full frame. */
	int32_t cfg_width, cfg_height;
	int32_t sent_width, sent_height;

	/* set_window_geometry: the window without its shadow margins. */
	bool has_geometry;
	struct wdc_rect geometry;
	struct wdc_rect pending_geometry;
	bool pending_geometry_set;
};

struct wdc_toplevel {
	struct wl_resource *resource;
	struct wdc_xdg_surface *xdg;
	char *title;
	char *app_id;
	/* A toplevel with a parent is a dialog belonging to that window. */
	struct wdc_xdg_surface *parent;
	/* What the application says it can be resized to. Asking for less than
	 * its minimum just produces a window bigger than the space we gave it. */
	int32_t min_width, min_height;
	int32_t max_width, max_height;
};

struct wdc_popup {
	struct wl_resource *resource;
	struct wdc_xdg_surface *xdg;
	struct wdc_xdg_surface *parent;
	struct wl_list link; /* wdc_server.popups, most recent first */
	/* Only a popup that asked for a grab is modal. Toolkits create popup
	 * objects long before they show one, so this is the difference between
	 * "a menu is open" and "an object exists". */
	bool grabbed;
	struct wdc_rect placement;
};

struct wdc_positioner {
	struct wl_resource *resource;
	int32_t width, height;
	struct wdc_rect anchor_rect;
	int32_t offset_x, offset_y;
	uint32_t anchor;
	uint32_t gravity;
	uint32_t constraint;
};

static uint32_t next_serial(struct wdc_server *server) {
	return ++server->serial;
}

/* Defined with the xdg roles, needed by the renderer above them. */
static void window_announce(struct wdc_xdg_surface *xdg);

/* ------------------------------------------------------------------ */
/* Rendering a commit                                                  */
/* ------------------------------------------------------------------ */

/*
 * shm pixels are little-endian packed, so ARGB8888 and XRGB8888 both arrive
 * as B,G,R,A in memory. Everything else we decline rather than guess.
 */
static bool convert_to_rgba(struct wl_shm_buffer *shm, int32_t src_x,
		int32_t src_y, int32_t width, int32_t height, unsigned char *out) {
	uint32_t format = wl_shm_buffer_get_format(shm);
	if (format != WL_SHM_FORMAT_ARGB8888 && format != WL_SHM_FORMAT_XRGB8888) {
		logmsg("unsupported shm format 0x%08x", format);
		return false;
	}
	bool opaque = format == WL_SHM_FORMAT_XRGB8888;

	int32_t stride = wl_shm_buffer_get_stride(shm);
	const unsigned char *src = wl_shm_buffer_get_data(shm);
	if (!src) return false;

	for (int32_t y = 0; y < height; y++) {
		const unsigned char *s = src + (size_t)stride * (size_t)(src_y + y) +
			(size_t)(src_x) * 4;
		unsigned char *d = out + (size_t)width * 4 * (size_t)y;
		for (int32_t x = 0; x < width; x++) {
			d[0] = s[2];
			d[1] = s[1];
			d[2] = s[0];
			d[3] = opaque ? 0xff : s[3];
			s += 4;
			d += 4;
		}
	}
	return true;
}

static const char *surface_label(struct wdc_surface *surface) {
	if (surface->xdg && surface->xdg->toplevel) {
		struct wdc_toplevel *t = surface->xdg->toplevel;
		if (t->title) return t->title;
		if (t->app_id) return t->app_id;
		return "toplevel";
	}
	if (surface->xdg && surface->xdg->popup) return "popup";
	return "surface";
}

/*
 * Where the window actually is inside the buffer.
 *
 * Applications draw their own decorations, and GTK pads the buffer with
 * invisible margins for its drop shadow. set_window_geometry is the real
 * window inside that buffer; ignore it and every window gains a fat
 * transparent border.
 */
static struct wdc_rect window_rect(struct wdc_surface *surface, int32_t buf_w,
		int32_t buf_h) {
	struct wdc_rect full = {0, 0, buf_w, buf_h};
	if (!surface->xdg || !surface->xdg->has_geometry) return full;

	struct wdc_rect g = surface->xdg->geometry;
	int32_t scale = surface->scale > 0 ? surface->scale : 1;
	struct wdc_rect r = {g.x * scale, g.y * scale, g.width * scale,
		g.height * scale};

	/* The client's geometry is a claim; clamp it to the buffer we have. */
	if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 ||
			r.x + r.width > buf_w || r.y + r.height > buf_h) {
		return full;
	}
	return r;
}

/*
 * The damaged part of the window, in window-local coordinates — this is what
 * keeps a keystroke from costing a megabyte. Falls back to the whole window
 * when damage is missing, overflowed, or the size changed under us.
 */
static struct wdc_rect damage_bounds(struct wdc_surface *surface,
		struct wdc_rect win, bool force_full) {
	struct wdc_rect full = {0, 0, win.width, win.height};
	if (force_full || surface->damage_overflow || surface->damage_count == 0) {
		return full;
	}

	int32_t x0 = INT32_MAX, y0 = INT32_MAX, x1 = 0, y1 = 0;
	for (int i = 0; i < surface->damage_count; i++) {
		struct wdc_rect d = surface->damage[i];
		int32_t dx0 = d.x - win.x, dy0 = d.y - win.y;
		int32_t dx1 = dx0 + d.width, dy1 = dy0 + d.height;
		if (dx0 < 0) dx0 = 0;
		if (dy0 < 0) dy0 = 0;
		if (dx1 > win.width) dx1 = win.width;
		if (dy1 > win.height) dy1 = win.height;
		if (dx1 <= dx0 || dy1 <= dy0) continue;
		if (dx0 < x0) x0 = dx0;
		if (dy0 < y0) y0 = dy0;
		if (dx1 > x1) x1 = dx1;
		if (dy1 > y1) y1 = dy1;
	}
	if (x1 <= x0 || y1 <= y0) return full;
	return (struct wdc_rect){x0, y0, x1 - x0, y1 - y0};
}

/* Stage 2 sink: the damaged rectangle, deflated, down the pipe. */
static void emit_frame_ipc(struct wdc_surface *surface,
		struct wl_shm_buffer *shm, struct wdc_rect win) {
	struct wdc_server *server = surface->server;
	struct wdc_xdg_surface *xdg = surface->xdg;

	window_announce(xdg);

	bool resized = xdg->sent_width != win.width ||
		xdg->sent_height != win.height;
	struct wdc_rect d = damage_bounds(surface, win, resized);

	size_t raw_len = (size_t)d.width * (size_t)d.height * 4;
	unsigned char *rgba = malloc(raw_len);
	if (!rgba) return;
	if (!convert_to_rgba(shm, win.x + d.x, win.y + d.y, d.width, d.height,
			rgba)) {
		free(rgba);
		return;
	}

	/*
	 * Interface pixels deflate to a fraction of their size, and level 1 costs
	 * far less than shipping raw RGBA over a tunnel would. If it does not
	 * help — already-compressed photographic content — send the raw bytes.
	 */
	uint8_t flags = 0;
	const unsigned char *payload = rgba;
	size_t payload_len = raw_len;

	uLongf comp_len = compressBound(raw_len);
	unsigned char *comp = malloc(comp_len);
	if (comp && compress2(comp, &comp_len, rgba, raw_len, 1) == Z_OK &&
			comp_len < raw_len) {
		flags = IPC_FRAME_DEFLATE;
		payload = comp;
		payload_len = comp_len;
	}

	uint8_t head[29];
	ipc_put_u32(head + 0, xdg->id);
	ipc_put_u32(head + 4, (uint32_t)d.x);
	ipc_put_u32(head + 8, (uint32_t)d.y);
	ipc_put_u32(head + 12, (uint32_t)d.width);
	ipc_put_u32(head + 16, (uint32_t)d.height);
	ipc_put_u32(head + 20, (uint32_t)win.width);
	ipc_put_u32(head + 24, (uint32_t)win.height);
	head[28] = flags;

	if (ipc_send(server->ipc, IPC_FRAME, head, sizeof head, payload,
			payload_len) != 0) {
		logmsg("the server closed the channel");
		server->running = false;
	}

	xdg->sent_width = win.width;
	xdg->sent_height = win.height;
	surface->awaiting_ack = true;
	surface->frame_sent_ms = now_ms();
	server->frames_written++;

	logdbg("frame w%u  %d,%d %dx%d of %dx%d  %zu -> %zu bytes", xdg->id,
		d.x, d.y, d.width, d.height, win.width, win.height, raw_len,
		payload_len);

	free(comp);
	free(rgba);
}

/* Stage 1 sink: a PNG per commit, for looking at without a browser. */
static void emit_frame_png(struct wdc_surface *surface,
		struct wl_shm_buffer *shm, struct wdc_rect win, int32_t buf_w,
		int32_t buf_h) {
	struct wdc_server *server = surface->server;

	unsigned char *rgba = malloc((size_t)win.width * (size_t)win.height * 4);
	if (!rgba || !convert_to_rgba(shm, win.x, win.y, win.width, win.height,
			rgba)) {
		free(rgba);
		return;
	}

	char path[512];
	snprintf(path, sizeof path, "%s/frame-%03d.png", server->outdir,
		server->frames_written);

	if (png_write_rgba(path, rgba, win.width, win.height, win.width * 4) == 0) {
		bool cropped = win.width != buf_w || win.height != buf_h;
		if (cropped) {
			logmsg("frame %d  %s  %dx%d (buffer %dx%d, cropped to window"
				" geometry)  -> %s", server->frames_written,
				surface_label(surface), win.width, win.height, buf_w, buf_h,
				path);
		} else {
			logmsg("frame %d  %s  %dx%d  -> %s", server->frames_written,
				surface_label(surface), win.width, win.height, path);
		}
		if (surface->damage_overflow) {
			logdbg("  damage: >%d rects (coalesced)", WDC_MAX_DAMAGE);
		} else {
			for (int i = 0; i < surface->damage_count; i++) {
				struct wdc_rect *d = &surface->damage[i];
				logdbg("  damage: %d,%d %dx%d", d->x, d->y, d->width, d->height);
			}
		}
		server->frames_written++;
	} else {
		logmsg("could not write %s: %s", path, strerror(errno));
	}

	free(rgba);
}

static void render_commit(struct wdc_surface *surface,
		struct wl_resource *buffer) {
	struct wdc_server *server = surface->server;

	/* An application with several windows can commit again in the same
	 * dispatch batch that reached the frame limit. Stop meaning stop. */
	if (!server->running) return;

	struct wl_shm_buffer *shm = wl_shm_buffer_get(buffer);
	if (!shm) {
		/*
		 * Almost certainly linux-dmabuf: the client is rendering on the GPU,
		 * which needs an EGL import we do not do — see docs/wayland.md.
		 */
		logmsg("commit with a non-shm buffer (GPU?) — cannot read it."
			" Try --force-shm, or GSK_RENDERER=cairo / QT_QUICK_BACKEND=software");
		return;
	}

	wl_shm_buffer_begin_access(shm);

	int32_t buf_w = wl_shm_buffer_get_width(shm);
	int32_t buf_h = wl_shm_buffer_get_height(shm);
	struct wdc_rect win = window_rect(surface, buf_w, buf_h);

	/*
	 * A configure of 0x0 is xdg-shell for "you choose". The application lays
	 * itself out at the size it wants and the first buffer it commits is the
	 * answer, so adopt it: from here on the window has a real size to be
	 * announced with, to place popups against, and to be resized from.
	 */
	if (surface->xdg && surface->xdg->toplevel && surface->xdg->cfg_width <= 0) {
		int32_t scale = surface->scale > 0 ? surface->scale : 1;
		surface->xdg->cfg_width = win.width / scale;
		surface->xdg->cfg_height = win.height / scale;
		logmsg("w%u chose its own size: %dx%d", surface->xdg->id,
			surface->xdg->cfg_width, surface->xdg->cfg_height);
	}

	if (server->ipc) {
		if (surface->xdg && (surface->xdg->toplevel || surface->xdg->popup)) {
			emit_frame_ipc(surface, shm, win);
		} else {
			logdbg("commit on a surface with no xdg role — subsurfaces are not"
				" composited");
		}
	} else {
		emit_frame_png(surface, shm, win, buf_w, buf_h);
	}

	wl_shm_buffer_end_access(shm);

	if (server->max_frames > 0 && server->frames_written >= server->max_frames) {
		logmsg("wrote %d frames, stopping", server->frames_written);
		server->running = false;
	}
}

/* ------------------------------------------------------------------ */
/* wl_surface                                                          */
/* ------------------------------------------------------------------ */

static void handle_pending_buffer_destroy(struct wl_listener *listener,
		void *data) {
	struct wdc_surface *surface =
		wl_container_of(listener, surface, pending_buffer_destroy);
	surface->pending_buffer = NULL;
	wl_list_remove(&listener->link);
	wl_list_init(&listener->link);
}

static void surface_track_buffer(struct wdc_surface *surface,
		struct wl_resource *buffer) {
	if (surface->pending_buffer) {
		wl_list_remove(&surface->pending_buffer_destroy.link);
		wl_list_init(&surface->pending_buffer_destroy.link);
	}
	surface->pending_buffer = buffer;
	if (buffer) {
		wl_resource_add_destroy_listener(buffer,
			&surface->pending_buffer_destroy);
	}
}

static void surface_add_damage(struct wdc_surface *surface, int32_t x, int32_t y,
		int32_t width, int32_t height) {
	if (width <= 0 || height <= 0) return;
	if (surface->damage_count >= WDC_MAX_DAMAGE) {
		surface->damage_overflow = true;
		return;
	}
	surface->damage[surface->damage_count++] =
		(struct wdc_rect){x, y, width, height};
}

static void surface_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void surface_attach(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *buffer, int32_t x,
		int32_t y) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	surface_track_buffer(surface, buffer);
	surface->pending_buffer_set = true;
}

static void surface_damage(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y, int32_t width,
		int32_t height) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	/* Surface-local; identical to buffer-local while scale is 1. */
	surface_add_damage(surface, x, y, width, height);
}

static void surface_frame(struct wl_client *client,
		struct wl_resource *resource, uint32_t callback) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	struct wl_resource *cb = wl_resource_create(client, &wl_callback_interface,
		1, callback);
	if (!cb) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(cb, NULL, NULL, NULL);
	wl_list_insert(surface->pending_frames.prev, wl_resource_get_link(cb));
}

/** Lets the client draw its next frame. */
static void surface_release_frames(struct wdc_surface *surface) {
	uint32_t t = now_ms();
	struct wl_resource *cb, *tmp;
	wl_resource_for_each_safe(cb, tmp, &surface->pending_frames) {
		wl_callback_send_done(cb, t);
		wl_resource_destroy(cb);
	}
	wl_list_init(&surface->pending_frames);
	surface->awaiting_ack = false;
}

static void surface_set_opaque_region(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *region) {}

static void surface_set_input_region(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *region) {}

static void surface_commit(struct wl_client *client,
		struct wl_resource *resource) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	struct wdc_xdg_surface *xdg = surface->xdg;

	if (surface->pending_scale > 0) surface->scale = surface->pending_scale;
	surface->pending_scale = 0;

	if (xdg && xdg->pending_geometry_set) {
		xdg->geometry = xdg->pending_geometry;
		xdg->has_geometry = true;
		xdg->pending_geometry_set = false;
	}

	/*
	 * xdg-shell: the first commit after a role is assigned carries no buffer
	 * and asks for a configure. Only once the client has acked that does it
	 * start rendering.
	 */
	if (xdg && !xdg->initial_configure_sent) {
		xdg_surface_send_configure(xdg->resource, next_serial(surface->server));
		xdg->initial_configure_sent = true;
		logdbg("sent initial configure");
	}

	if (surface->pending_buffer_set) {
		struct wl_resource *buffer = surface->pending_buffer;
		if (buffer) {
			render_commit(surface, buffer);
			/* We copied out of it synchronously, so it is free again. */
			wl_buffer_send_release(buffer);
		}
		surface_track_buffer(surface, NULL);
		surface->pending_buffer_set = false;
	}

	surface->damage_count = 0;
	surface->damage_overflow = false;

	/*
	 * Frame callbacks are the client's throttle: it will not draw again until
	 * one fires. With no browser attached they fire immediately; over IPC they
	 * wait for the acknowledgement, which is what keeps a fast application
	 * from outrunning the socket.
	 */
	if (!surface->awaiting_ack) surface_release_frames(surface);
}

static void surface_set_buffer_transform(struct wl_client *client,
		struct wl_resource *resource, int32_t transform) {}

static void surface_set_buffer_scale(struct wl_client *client,
		struct wl_resource *resource, int32_t scale) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	if (scale <= 0) {
		wl_resource_post_error(resource, WL_SURFACE_ERROR_INVALID_SCALE,
			"buffer scale must be positive");
		return;
	}
	surface->pending_scale = scale;
}

static void surface_damage_buffer(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y, int32_t width,
		int32_t height) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	surface_add_damage(surface, x, y, width, height);
}

static void surface_offset(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y) {}

static const struct wl_surface_interface surface_impl = {
	.destroy = surface_destroy_req,
	.attach = surface_attach,
	.damage = surface_damage,
	.frame = surface_frame,
	.set_opaque_region = surface_set_opaque_region,
	.set_input_region = surface_set_input_region,
	.commit = surface_commit,
	.set_buffer_transform = surface_set_buffer_transform,
	.set_buffer_scale = surface_set_buffer_scale,
	.damage_buffer = surface_damage_buffer,
	.offset = surface_offset,
};

static void surface_resource_destroy(struct wl_resource *resource) {
	struct wdc_surface *surface = wl_resource_get_user_data(resource);
	/* Input must never point at a surface that is going away. */
	if (surface->server->seat.pointer_focus == surface) {
		surface->server->seat.pointer_focus = NULL;
	}
	if (surface->server->seat.keyboard_focus == surface) {
		surface->server->seat.keyboard_focus = NULL;
	}
	if (surface->pending_buffer) {
		wl_list_remove(&surface->pending_buffer_destroy.link);
	}
	struct wl_resource *cb, *tmp;
	wl_resource_for_each_safe(cb, tmp, &surface->pending_frames) {
		wl_resource_destroy(cb);
	}
	if (surface->xdg) surface->xdg->surface = NULL;
	free(surface);
}

/* ------------------------------------------------------------------ */
/* wl_region — tracked only so the objects exist                       */
/* ------------------------------------------------------------------ */

static void region_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void region_add(struct wl_client *client, struct wl_resource *resource,
		int32_t x, int32_t y, int32_t width, int32_t height) {}

static void region_subtract(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y, int32_t width,
		int32_t height) {}

static const struct wl_region_interface region_impl = {
	.destroy = region_destroy_req,
	.add = region_add,
	.subtract = region_subtract,
};

/* ------------------------------------------------------------------ */
/* wl_compositor                                                       */
/* ------------------------------------------------------------------ */

static void compositor_create_surface(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_server *server = wl_resource_get_user_data(resource);

	struct wdc_surface *surface = calloc(1, sizeof *surface);
	if (!surface) {
		wl_client_post_no_memory(client);
		return;
	}
	surface->server = server;
	surface->scale = 1;
	wl_list_init(&surface->pending_frames);
	wl_list_init(&surface->pending_buffer_destroy.link);
	surface->pending_buffer_destroy.notify = handle_pending_buffer_destroy;

	surface->resource = wl_resource_create(client, &wl_surface_interface,
		wl_resource_get_version(resource), id);
	if (!surface->resource) {
		free(surface);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(surface->resource, &surface_impl, surface,
		surface_resource_destroy);
	logdbg("surface created");
}

static void compositor_create_region(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wl_resource *region = wl_resource_create(client,
		&wl_region_interface, wl_resource_get_version(resource), id);
	if (!region) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(region, &region_impl, NULL, NULL);
}

static const struct wl_compositor_interface compositor_impl = {
	.create_surface = compositor_create_surface,
	.create_region = compositor_create_region,
};

static void compositor_bind(struct wl_client *client, void *data,
		uint32_t version, uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&wl_compositor_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &compositor_impl, data, NULL);
}

/* ------------------------------------------------------------------ */
/* xdg_positioner                                                      */
/* ------------------------------------------------------------------ */

static void positioner_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void positioner_set_size(struct wl_client *client,
		struct wl_resource *resource, int32_t width, int32_t height) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->width = width;
	p->height = height;
}

static void positioner_set_anchor_rect(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y, int32_t width,
		int32_t height) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->anchor_rect = (struct wdc_rect){x, y, width, height};
}

static void positioner_set_anchor(struct wl_client *client,
		struct wl_resource *resource, uint32_t anchor) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->anchor = anchor;
}

static void positioner_set_gravity(struct wl_client *client,
		struct wl_resource *resource, uint32_t gravity) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->gravity = gravity;
}

static void positioner_set_constraint_adjustment(struct wl_client *client,
		struct wl_resource *resource, uint32_t constraint_adjustment) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->constraint = constraint_adjustment;
}

static void positioner_set_offset(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y) {
	struct wdc_positioner *p = wl_resource_get_user_data(resource);
	p->offset_x = x;
	p->offset_y = y;
}

static void positioner_set_reactive(struct wl_client *client,
		struct wl_resource *resource) {}

static void positioner_set_parent_size(struct wl_client *client,
		struct wl_resource *resource, int32_t parent_width,
		int32_t parent_height) {}

static void positioner_set_parent_configure(struct wl_client *client,
		struct wl_resource *resource, uint32_t serial) {}

static const struct xdg_positioner_interface positioner_impl = {
	.destroy = positioner_destroy_req,
	.set_size = positioner_set_size,
	.set_anchor_rect = positioner_set_anchor_rect,
	.set_anchor = positioner_set_anchor,
	.set_gravity = positioner_set_gravity,
	.set_constraint_adjustment = positioner_set_constraint_adjustment,
	.set_offset = positioner_set_offset,
	.set_reactive = positioner_set_reactive,
	.set_parent_size = positioner_set_parent_size,
	.set_parent_configure = positioner_set_parent_configure,
};

static void positioner_resource_destroy(struct wl_resource *resource) {
	free(wl_resource_get_user_data(resource));
}

/* ------------------------------------------------------------------ */
/* xdg_toplevel                                                        */
/* ------------------------------------------------------------------ */

static void toplevel_send_configure(struct wdc_toplevel *toplevel) {
	struct wdc_xdg_surface *xdg = toplevel->xdg;
	struct wl_array states;
	wl_array_init(&states);
	uint32_t *s = wl_array_add(&states, sizeof *s);
	if (s) *s = XDG_TOPLEVEL_STATE_ACTIVATED;

	xdg_toplevel_send_configure(toplevel->resource, xdg->cfg_width,
		xdg->cfg_height, &states);
	wl_array_release(&states);
}

/** A length-prefixed string, as the IPC messages carry them. */
#define WDC_MAX_STRING 1024
static size_t put_string(uint8_t *out, const char *s) {
	size_t len = s ? strlen(s) : 0;
	if (len > WDC_MAX_STRING) len = WDC_MAX_STRING;
	out[0] = (uint8_t)(len >> 8);
	out[1] = (uint8_t)len;
	if (len) memcpy(out + 2, s, len);
	return len + 2;
}

static struct wdc_server *xdg_server(struct wdc_xdg_surface *xdg) {
	if (!xdg || !xdg->surface) return NULL;
	return xdg->surface->server;
}

/*
 * Announce a window once it has content. Doing this when the role is assigned
 * would be earlier, but the title, the app id and a popup's placement are all
 * settled just before the first commit, and a window with no name and no
 * position is no use to the shell.
 */
static void window_announce(struct wdc_xdg_surface *xdg) {
	struct wdc_server *server = xdg_server(xdg);
	if (!server || !server->ipc || xdg->announced) return;
	xdg->announced = true;

	if (xdg->popup) {
		struct wdc_rect r = xdg->popup->placement;
		uint8_t msg[24];
		ipc_put_u32(msg + 0, xdg->id);
		ipc_put_u32(msg + 4, xdg->popup->parent ? xdg->popup->parent->id : 0);
		ipc_put_u32(msg + 8, (uint32_t)r.x);
		ipc_put_u32(msg + 12, (uint32_t)r.y);
		ipc_put_u32(msg + 16, (uint32_t)r.width);
		ipc_put_u32(msg + 20, (uint32_t)r.height);
		if (ipc_send(server->ipc, IPC_POPUP, msg, sizeof msg, NULL, 0) != 0) {
			server->running = false;
		}
		return;
	}

	struct wdc_toplevel *toplevel = xdg->toplevel;
	if (!toplevel) return;

	uint8_t msg[16 + 2 * (2 + WDC_MAX_STRING)];
	size_t at = 0;
	ipc_put_u32(msg + at, xdg->id);
	at += 4;
	ipc_put_u32(msg + at, (uint32_t)xdg->cfg_width);
	at += 4;
	ipc_put_u32(msg + at, (uint32_t)xdg->cfg_height);
	at += 4;
	/* A parent makes this a dialog belonging to that window. */
	ipc_put_u32(msg + at, toplevel->parent ? toplevel->parent->id : 0);
	at += 4;
	at += put_string(msg + at, toplevel->title);
	at += put_string(msg + at, toplevel->app_id);

	if (ipc_send(server->ipc, IPC_WINDOW, msg, at, NULL, 0) != 0) {
		server->running = false;
	}
}

/** What the application says it can be resized to. */
static void toplevel_send_bounds(struct wdc_toplevel *toplevel) {
	struct wdc_server *server = xdg_server(toplevel->xdg);
	if (!server || !server->ipc || !toplevel->xdg->announced) return;

	uint8_t msg[20];
	ipc_put_u32(msg + 0, toplevel->xdg->id);
	ipc_put_u32(msg + 4, (uint32_t)toplevel->min_width);
	ipc_put_u32(msg + 8, (uint32_t)toplevel->min_height);
	ipc_put_u32(msg + 12, (uint32_t)toplevel->max_width);
	ipc_put_u32(msg + 16, (uint32_t)toplevel->max_height);
	ipc_send(server->ipc, IPC_BOUNDS, msg, sizeof msg, NULL, 0);
}

static void toplevel_send_title(struct wdc_toplevel *toplevel) {
	struct wdc_server *server = xdg_server(toplevel->xdg);
	if (!server || !server->ipc || !toplevel->xdg->announced) return;

	uint8_t msg[4 + 2 + WDC_MAX_STRING];
	ipc_put_u32(msg, toplevel->xdg->id);
	size_t at = 4 + put_string(msg + 4, toplevel->title);

	if (ipc_send(server->ipc, IPC_TITLE, msg, at, NULL, 0) != 0) {
		server->running = false;
	}
}

/** Tells the shell the application wants to be dragged or resized. */
static void send_interaction(struct wdc_xdg_surface *xdg, uint8_t type,
		uint32_t extra, bool has_extra) {
	struct wdc_server *server = xdg_server(xdg);
	if (!server || !server->ipc) return;
	uint8_t msg[8];
	ipc_put_u32(msg, xdg->id);
	if (has_extra) ipc_put_u32(msg + 4, extra);
	ipc_send(server->ipc, type, msg, has_extra ? 8 : 4, NULL, 0);
}

static void toplevel_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void toplevel_set_parent(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *parent) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	struct wdc_toplevel *other =
		parent ? wl_resource_get_user_data(parent) : NULL;
	toplevel->parent = other ? other->xdg : NULL;
	if (toplevel->parent) {
		logdbg("w%u is a dialog of w%u", toplevel->xdg->id,
			toplevel->parent->id);
	}
}

static void toplevel_set_title(struct wl_client *client,
		struct wl_resource *resource, const char *title) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	free(toplevel->title);
	toplevel->title = strdup(title);
	logdbg("w%u title: %s", toplevel->xdg->id, title);
	toplevel_send_title(toplevel);
}

static void toplevel_set_app_id(struct wl_client *client,
		struct wl_resource *resource, const char *app_id) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	free(toplevel->app_id);
	toplevel->app_id = strdup(app_id);
	logmsg("app_id: %s", app_id);
}

static void toplevel_show_window_menu(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *seat, uint32_t serial,
		int32_t x, int32_t y) {}

/*
 * The application drew its own titlebar and the user is dragging it. This is
 * the shell being asked to start one of its own window drags — which it
 * already knows how to do.
 */
static void toplevel_move(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *seat,
		uint32_t serial) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	logdbg("w%u asked to be moved", toplevel->xdg->id);
	send_interaction(toplevel->xdg, IPC_MOVE, 0, false);
}

static void toplevel_resize(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *seat, uint32_t serial,
		uint32_t edges) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	logdbg("w%u asked to be resized, edges %u", toplevel->xdg->id, edges);
	send_interaction(toplevel->xdg, IPC_RESIZE, edges, true);
}

static void toplevel_set_max_size(struct wl_client *client,
		struct wl_resource *resource, int32_t width, int32_t height) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	toplevel->max_width = width > 0 ? width : 0;
	toplevel->max_height = height > 0 ? height : 0;
	toplevel_send_bounds(toplevel);
}

static void toplevel_set_min_size(struct wl_client *client,
		struct wl_resource *resource, int32_t width, int32_t height) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	toplevel->min_width = width > 0 ? width : 0;
	toplevel->min_height = height > 0 ? height : 0;
	toplevel_send_bounds(toplevel);
}

static void toplevel_set_maximized(struct wl_client *client,
		struct wl_resource *resource) {}

static void toplevel_unset_maximized(struct wl_client *client,
		struct wl_resource *resource) {}

static void toplevel_set_fullscreen(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *output) {}

static void toplevel_unset_fullscreen(struct wl_client *client,
		struct wl_resource *resource) {}

static void toplevel_set_minimized(struct wl_client *client,
		struct wl_resource *resource) {}

static const struct xdg_toplevel_interface toplevel_impl = {
	.destroy = toplevel_destroy_req,
	.set_parent = toplevel_set_parent,
	.set_title = toplevel_set_title,
	.set_app_id = toplevel_set_app_id,
	.show_window_menu = toplevel_show_window_menu,
	.move = toplevel_move,
	.resize = toplevel_resize,
	.set_max_size = toplevel_set_max_size,
	.set_min_size = toplevel_set_min_size,
	.set_maximized = toplevel_set_maximized,
	.unset_maximized = toplevel_unset_maximized,
	.set_fullscreen = toplevel_set_fullscreen,
	.unset_fullscreen = toplevel_unset_fullscreen,
	.set_minimized = toplevel_set_minimized,
};

static void toplevel_resource_destroy(struct wl_resource *resource) {
	struct wdc_toplevel *toplevel = wl_resource_get_user_data(resource);
	logmsg("toplevel w%u closed: %s", toplevel->xdg ? toplevel->xdg->id : 0,
		toplevel->title ? toplevel->title : "(untitled)");
	if (toplevel->xdg) toplevel->xdg->toplevel = NULL;
	free(toplevel->title);
	free(toplevel->app_id);
	free(toplevel);
}

/* ------------------------------------------------------------------ */
/* Placing a popup                                                     */
/*                                                                     */
/* A menu is anchored to a rectangle inside its parent, extends in the */
/* direction the gravity names, and must stay somewhere it can be seen.*/
/* Our "output" is the parent window, so constraining to that is not a */
/* compromise — it is the same rule a real compositor applies to a     */
/* screen edge.                                                        */
/* ------------------------------------------------------------------ */

static void anchor_point(uint32_t anchor, struct wdc_rect r, int32_t *x,
		int32_t *y) {
	*x = r.x + r.width / 2;
	*y = r.y + r.height / 2;
	switch (anchor) {
	case XDG_POSITIONER_ANCHOR_TOP: *y = r.y; break;
	case XDG_POSITIONER_ANCHOR_BOTTOM: *y = r.y + r.height; break;
	case XDG_POSITIONER_ANCHOR_LEFT: *x = r.x; break;
	case XDG_POSITIONER_ANCHOR_RIGHT: *x = r.x + r.width; break;
	case XDG_POSITIONER_ANCHOR_TOP_LEFT: *x = r.x; *y = r.y; break;
	case XDG_POSITIONER_ANCHOR_BOTTOM_LEFT:
		*x = r.x;
		*y = r.y + r.height;
		break;
	case XDG_POSITIONER_ANCHOR_TOP_RIGHT: *x = r.x + r.width; *y = r.y; break;
	case XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT:
		*x = r.x + r.width;
		*y = r.y + r.height;
		break;
	default: break;
	}
}

/** Where the popup sits relative to the anchor point. */
static void gravity_offset(uint32_t gravity, int32_t w, int32_t h, int32_t *dx,
		int32_t *dy) {
	*dx = -w / 2;
	*dy = -h / 2;
	switch (gravity) {
	case XDG_POSITIONER_GRAVITY_TOP: *dy = -h; break;
	case XDG_POSITIONER_GRAVITY_BOTTOM: *dy = 0; break;
	case XDG_POSITIONER_GRAVITY_LEFT: *dx = -w; break;
	case XDG_POSITIONER_GRAVITY_RIGHT: *dx = 0; break;
	case XDG_POSITIONER_GRAVITY_TOP_LEFT: *dx = -w; *dy = -h; break;
	case XDG_POSITIONER_GRAVITY_BOTTOM_LEFT: *dx = -w; *dy = 0; break;
	case XDG_POSITIONER_GRAVITY_TOP_RIGHT: *dx = 0; *dy = -h; break;
	case XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT: *dx = 0; *dy = 0; break;
	default: break;
	}
}

static uint32_t flip_x(uint32_t v) {
	switch (v) {
	case XDG_POSITIONER_ANCHOR_LEFT: return XDG_POSITIONER_ANCHOR_RIGHT;
	case XDG_POSITIONER_ANCHOR_RIGHT: return XDG_POSITIONER_ANCHOR_LEFT;
	case XDG_POSITIONER_ANCHOR_TOP_LEFT: return XDG_POSITIONER_ANCHOR_TOP_RIGHT;
	case XDG_POSITIONER_ANCHOR_TOP_RIGHT: return XDG_POSITIONER_ANCHOR_TOP_LEFT;
	case XDG_POSITIONER_ANCHOR_BOTTOM_LEFT:
		return XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT;
	case XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT:
		return XDG_POSITIONER_ANCHOR_BOTTOM_LEFT;
	default: return v;
	}
}

static uint32_t flip_y(uint32_t v) {
	switch (v) {
	case XDG_POSITIONER_ANCHOR_TOP: return XDG_POSITIONER_ANCHOR_BOTTOM;
	case XDG_POSITIONER_ANCHOR_BOTTOM: return XDG_POSITIONER_ANCHOR_TOP;
	case XDG_POSITIONER_ANCHOR_TOP_LEFT:
		return XDG_POSITIONER_ANCHOR_BOTTOM_LEFT;
	case XDG_POSITIONER_ANCHOR_BOTTOM_LEFT:
		return XDG_POSITIONER_ANCHOR_TOP_LEFT;
	case XDG_POSITIONER_ANCHOR_TOP_RIGHT:
		return XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT;
	case XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT:
		return XDG_POSITIONER_ANCHOR_TOP_RIGHT;
	default: return v;
	}
}

static void place_with(struct wdc_positioner *p, uint32_t anchor,
		uint32_t gravity, int32_t w, int32_t h, int32_t *x, int32_t *y) {
	int32_t ax, ay, dx, dy;
	anchor_point(anchor, p->anchor_rect, &ax, &ay);
	gravity_offset(gravity, w, h, &dx, &dy);
	*x = ax + dx + p->offset_x;
	*y = ay + dy + p->offset_y;
}

/** Result is relative to the parent window's own geometry origin. */
static struct wdc_rect popup_place(struct wdc_positioner *p,
		struct wdc_rect parent) {
	int32_t w = p->width > 0 ? p->width : 1;
	int32_t h = p->height > 0 ? p->height : 1;
	if (w > parent.width) w = parent.width;
	if (h > parent.height) h = parent.height;

	int32_t x, y;
	place_with(p, p->anchor, p->gravity, w, h, &x, &y);

	/* Flip first: a menu that would fall off the bottom belongs above its
	 * button, not slid up over it. */
	if ((p->constraint & XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_FLIP_X) &&
			(x < 0 || x + w > parent.width)) {
		int32_t fx, fy;
		place_with(p, flip_x(p->anchor), flip_x(p->gravity), w, h, &fx, &fy);
		if (fx >= 0 && fx + w <= parent.width) x = fx;
	}
	if ((p->constraint & XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_FLIP_Y) &&
			(y < 0 || y + h > parent.height)) {
		int32_t fx, fy;
		place_with(p, flip_y(p->anchor), flip_y(p->gravity), w, h, &fx, &fy);
		if (fy >= 0 && fy + h <= parent.height) y = fy;
	}

	/*
	 * Then slide it back inside. The protocol only asks for this when the
	 * client allows it, but a menu we place outside the window is a menu
	 * nobody can click, so it happens either way.
	 */
	if (x + w > parent.width) x = parent.width - w;
	if (y + h > parent.height) y = parent.height - h;
	if (x < 0) x = 0;
	if (y < 0) y = 0;

	return (struct wdc_rect){x, y, w, h};
}

/** The parent window's own box, which is what a popup is confined to. */
static struct wdc_rect popup_bounds(struct wdc_popup *popup,
		struct wdc_server *server) {
	struct wdc_rect bounds = {0, 0, server->width, server->height};
	if (!popup->parent) return bounds;
	bounds.width = popup->parent->cfg_width;
	bounds.height = popup->parent->cfg_height;
	if (popup->parent->has_geometry) {
		bounds.width = popup->parent->geometry.width;
		bounds.height = popup->parent->geometry.height;
	}
	return bounds;
}

/** Tells the shell where a popup is, now that it has moved. */
static void popup_send_placement(struct wdc_popup *popup) {
	struct wdc_server *server = xdg_server(popup->xdg);
	if (!server || !server->ipc || !popup->xdg->announced) return;

	struct wdc_rect r = popup->placement;
	uint8_t msg[24];
	ipc_put_u32(msg + 0, popup->xdg->id);
	ipc_put_u32(msg + 4, popup->parent ? popup->parent->id : 0);
	ipc_put_u32(msg + 8, (uint32_t)r.x);
	ipc_put_u32(msg + 12, (uint32_t)r.y);
	ipc_put_u32(msg + 16, (uint32_t)r.width);
	ipc_put_u32(msg + 20, (uint32_t)r.height);
	ipc_send(server->ipc, IPC_POPUP, msg, sizeof msg, NULL, 0);
}

/* ------------------------------------------------------------------ */
/* xdg_popup                                                           */
/* ------------------------------------------------------------------ */

static void popup_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void popup_grab(struct wl_client *client, struct wl_resource *resource,
		struct wl_resource *seat, uint32_t serial) {
	struct wdc_popup *popup = wl_resource_get_user_data(resource);
	popup->grabbed = true;
	logdbg("popup took a grab");
}

/*
 * GTK 4 opens a menu by creating the popup and immediately repositioning it,
 * and it will not attach a buffer until the reposition has been answered.
 * Ignoring this request is indistinguishable from a menu that never opens.
 */
static void popup_reposition(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *positioner,
		uint32_t token) {
	struct wdc_popup *popup = wl_resource_get_user_data(resource);
	struct wdc_positioner *p = wl_resource_get_user_data(positioner);
	struct wdc_server *server = xdg_server(popup->xdg);
	if (!server || !p) return;

	popup->placement = popup_place(p, popup_bounds(popup, server));
	logdbg("popup w%u repositioned to %dx%d at %d,%d", popup->xdg->id,
		popup->placement.width, popup->placement.height, popup->placement.x,
		popup->placement.y);

	if (wl_resource_get_version(resource) >=
			XDG_POPUP_REPOSITIONED_SINCE_VERSION) {
		xdg_popup_send_repositioned(resource, token);
	}
	xdg_popup_send_configure(resource, popup->placement.x, popup->placement.y,
		popup->placement.width, popup->placement.height);
	xdg_surface_send_configure(popup->xdg->resource, next_serial(server));

	popup_send_placement(popup);
}

static const struct xdg_popup_interface popup_impl = {
	.destroy = popup_destroy_req,
	.grab = popup_grab,
	.reposition = popup_reposition,
};

static void popup_resource_destroy(struct wl_resource *resource) {
	struct wdc_popup *popup = wl_resource_get_user_data(resource);
	wl_list_remove(&popup->link);
	if (popup->xdg) popup->xdg->popup = NULL;
	free(popup);
}

/* ------------------------------------------------------------------ */
/* xdg_surface                                                         */
/* ------------------------------------------------------------------ */

static void xdg_surface_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void xdg_surface_get_toplevel(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_xdg_surface *xdg = wl_resource_get_user_data(resource);

	struct wdc_toplevel *toplevel = calloc(1, sizeof *toplevel);
	if (!toplevel) {
		wl_client_post_no_memory(client);
		return;
	}
	toplevel->xdg = xdg;
	toplevel->resource = wl_resource_create(client, &xdg_toplevel_interface,
		wl_resource_get_version(resource), id);
	if (!toplevel->resource) {
		free(toplevel);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(toplevel->resource, &toplevel_impl, toplevel,
		toplevel_resource_destroy);
	xdg->toplevel = toplevel;

	if (xdg->cfg_width > 0) {
		logmsg("new toplevel w%u — configuring at %dx%d", xdg->id,
			xdg->cfg_width, xdg->cfg_height);
	} else {
		logmsg("new toplevel w%u — letting it choose its own size", xdg->id);
	}
	toplevel_send_configure(toplevel);
}

static void xdg_surface_get_popup(struct wl_client *client,
		struct wl_resource *resource, uint32_t id, struct wl_resource *parent,
		struct wl_resource *positioner_resource) {
	struct wdc_xdg_surface *xdg = wl_resource_get_user_data(resource);
	struct wdc_positioner *p = wl_resource_get_user_data(positioner_resource);

	struct wdc_popup *popup = calloc(1, sizeof *popup);
	if (!popup) {
		wl_client_post_no_memory(client);
		return;
	}
	popup->xdg = xdg;
	popup->parent = parent ? wl_resource_get_user_data(parent) : NULL;
	popup->resource = wl_resource_create(client, &xdg_popup_interface,
		wl_resource_get_version(resource), id);
	if (!popup->resource) {
		free(popup);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(popup->resource, &popup_impl, popup,
		popup_resource_destroy);
	xdg->popup = popup;
	wl_list_insert(&xdg->surface->server->popups, &popup->link);

	/* Anchored inside the parent's window, and kept where it can be seen. */
	popup->placement = popup_place(p, popup_bounds(popup, xdg->surface->server));

	logmsg("new popup w%u of w%u — %dx%d at %d,%d", xdg->id,
		popup->parent ? popup->parent->id : 0, popup->placement.width,
		popup->placement.height, popup->placement.x, popup->placement.y);

	xdg_popup_send_configure(popup->resource, popup->placement.x,
		popup->placement.y, popup->placement.width, popup->placement.height);
}

static void xdg_surface_set_window_geometry(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y, int32_t width,
		int32_t height) {
	struct wdc_xdg_surface *xdg = wl_resource_get_user_data(resource);
	xdg->pending_geometry = (struct wdc_rect){x, y, width, height};
	xdg->pending_geometry_set = true;
}

static void xdg_surface_ack_configure(struct wl_client *client,
		struct wl_resource *resource, uint32_t serial) {
	struct wdc_xdg_surface *xdg = wl_resource_get_user_data(resource);
	xdg->last_acked = serial;
}

static const struct xdg_surface_interface xdg_surface_impl = {
	.destroy = xdg_surface_destroy_req,
	.get_toplevel = xdg_surface_get_toplevel,
	.get_popup = xdg_surface_get_popup,
	.set_window_geometry = xdg_surface_set_window_geometry,
	.ack_configure = xdg_surface_ack_configure,
};

static void xdg_surface_resource_destroy(struct wl_resource *resource) {
	struct wdc_xdg_surface *xdg = wl_resource_get_user_data(resource);
	struct wdc_server *server = xdg_server(xdg);

	if (server && server->ipc && xdg->announced) {
		uint8_t msg[4];
		ipc_put_u32(msg, xdg->id);
		ipc_send(server->ipc, IPC_CLOSED, msg, sizeof msg, NULL, 0);
	}

	wl_list_remove(&xdg->link);
	if (xdg->surface) xdg->surface->xdg = NULL;
	if (xdg->toplevel) xdg->toplevel->xdg = NULL;
	if (xdg->popup) xdg->popup->xdg = NULL;
	free(xdg);
}

/* ------------------------------------------------------------------ */
/* xdg_wm_base                                                         */
/* ------------------------------------------------------------------ */

static void wm_base_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void wm_base_create_positioner(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_positioner *p = calloc(1, sizeof *p);
	if (!p) {
		wl_client_post_no_memory(client);
		return;
	}
	p->resource = wl_resource_create(client, &xdg_positioner_interface,
		wl_resource_get_version(resource), id);
	if (!p->resource) {
		free(p);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(p->resource, &positioner_impl, p,
		positioner_resource_destroy);
}

static void wm_base_get_xdg_surface(struct wl_client *client,
		struct wl_resource *resource, uint32_t id,
		struct wl_resource *surface_resource) {
	struct wdc_surface *surface = wl_resource_get_user_data(surface_resource);

	if (surface->xdg) {
		wl_resource_post_error(resource, XDG_WM_BASE_ERROR_ROLE,
			"surface already has an xdg role");
		return;
	}

	struct wdc_server *server = surface->server;
	struct wdc_xdg_surface *xdg = calloc(1, sizeof *xdg);
	if (!xdg) {
		wl_client_post_no_memory(client);
		return;
	}
	xdg->surface = surface;
	xdg->id = ++server->next_window_id;
	xdg->cfg_width = server->width;
	xdg->cfg_height = server->height;
	xdg->resource = wl_resource_create(client, &xdg_surface_interface,
		wl_resource_get_version(resource), id);
	if (!xdg->resource) {
		free(xdg);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(xdg->resource, &xdg_surface_impl, xdg,
		xdg_surface_resource_destroy);
	surface->xdg = xdg;
	wl_list_insert(&server->windows, &xdg->link);
}

static void wm_base_pong(struct wl_client *client, struct wl_resource *resource,
		uint32_t serial) {}

static const struct xdg_wm_base_interface wm_base_impl = {
	.destroy = wm_base_destroy_req,
	.create_positioner = wm_base_create_positioner,
	.get_xdg_surface = wm_base_get_xdg_surface,
	.pong = wm_base_pong,
};

static void wm_base_bind(struct wl_client *client, void *data, uint32_t version,
		uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&xdg_wm_base_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &wm_base_impl, data, NULL);
}

/* ------------------------------------------------------------------ */
/* wl_output                                                           */
/* ------------------------------------------------------------------ */

static void output_release(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static const struct wl_output_interface output_impl = {
	.release = output_release,
};

static void output_bind(struct wl_client *client, void *data, uint32_t version,
		uint32_t id) {
	struct wdc_server *server = data;
	struct wl_resource *resource = wl_resource_create(client,
		&wl_output_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &output_impl, server, NULL);

	wl_output_send_geometry(resource, 0, 0, 0, 0, WL_OUTPUT_SUBPIXEL_UNKNOWN,
		"Finestra", "wdcomp", WL_OUTPUT_TRANSFORM_NORMAL);
	wl_output_send_mode(resource,
		WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED, server->width,
		server->height, 60000);
	if (version >= WL_OUTPUT_SCALE_SINCE_VERSION) {
		wl_output_send_scale(resource, server->scale > 0 ? server->scale : 1);
	}
	if (version >= WL_OUTPUT_DONE_SINCE_VERSION) {
		wl_output_send_done(resource);
	}
}

/* ------------------------------------------------------------------ */
/* wl_seat — pointer and keyboard                                      */
/* ------------------------------------------------------------------ */

/** The keymap travels as a file descriptor, so it needs to live in one. */
static int keymap_fd(struct wdc_seat *seat) {
	int fd = memfd_create("wdcomp-keymap", MFD_CLOEXEC);
	if (fd < 0) return -1;
	if (ftruncate(fd, (off_t)seat->keymap_size) != 0) {
		close(fd);
		return -1;
	}
	void *map = mmap(NULL, seat->keymap_size, PROT_READ | PROT_WRITE,
		MAP_SHARED, fd, 0);
	if (map == MAP_FAILED) {
		close(fd);
		return -1;
	}
	memcpy(map, seat->keymap_string, seat->keymap_size);
	munmap(map, seat->keymap_size);
	return fd;
}

static bool seat_init(struct wdc_seat *seat, const char *layout,
		const char *variant, const char *options) {
	wl_list_init(&seat->pointers);
	wl_list_init(&seat->keyboards);
	wl_list_init(&seat->data_devices);
	wl_array_init(&seat->pressed);

	seat->xkb = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	if (!seat->xkb) return false;

	struct xkb_rule_names names = {
		.rules = NULL,
		.model = "pc105",
		.layout = layout,
		.variant = variant,
		.options = options,
	};
	seat->keymap = xkb_keymap_new_from_names(seat->xkb, &names,
		XKB_KEYMAP_COMPILE_NO_FLAGS);
	if (!seat->keymap) {
		logmsg("could not compile a keymap for layout '%s'", layout);
		return false;
	}

	seat->keymap_string = xkb_keymap_get_as_string(seat->keymap,
		XKB_KEYMAP_FORMAT_TEXT_V1);
	if (!seat->keymap_string) return false;
	seat->keymap_size = strlen(seat->keymap_string) + 1;

	seat->xkb_state = xkb_state_new(seat->keymap);
	return seat->xkb_state != NULL;
}

static void seat_finish(struct wdc_seat *seat) {
	free(seat->offered);
	wl_array_release(&seat->pressed);
	if (seat->xkb_state) xkb_state_unref(seat->xkb_state);
	if (seat->keymap) xkb_keymap_unref(seat->keymap);
	if (seat->xkb) xkb_context_unref(seat->xkb);
	free(seat->keymap_string);
}

/** Only resources belonging to the client that owns the focused surface. */
static bool same_client(struct wl_resource *a, struct wl_resource *b) {
	return wl_resource_get_client(a) == wl_resource_get_client(b);
}

static void pointer_send_frame(struct wdc_seat *seat,
		struct wl_resource *surface) {
	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface)) continue;
		if (wl_resource_get_version(pointer) >= WL_POINTER_FRAME_SINCE_VERSION) {
			wl_pointer_send_frame(pointer);
		}
	}
}

static void seat_pointer_leave(struct wdc_server *server);

static void seat_pointer_enter(struct wdc_server *server,
		struct wdc_surface *surface, int32_t x, int32_t y) {
	struct wdc_seat *seat = &server->seat;
	if (seat->pointer_focus == surface) return;

	/* Moving between surfaces — window to menu and back — is a leave and an
	 * enter, in that order. Skipping the leave leaves the old surface
	 * believing the pointer is still inside it. */
	if (seat->pointer_focus) seat_pointer_leave(server);

	seat->pointer_focus = surface;
	/* Forget the shape: the application sets one per enter, and the browser
	 * must not keep showing the previous surface's cursor if it does not. */
	seat->cursor_shape = WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT;

	uint32_t serial = next_serial(server);
	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface->resource)) continue;
		wl_pointer_send_enter(pointer, serial, surface->resource,
			wl_fixed_from_int(x), wl_fixed_from_int(y));
	}
	pointer_send_frame(seat, surface->resource);
}

static void seat_pointer_leave(struct wdc_server *server) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->pointer_focus;
	if (!surface) return;
	seat->pointer_focus = NULL;

	uint32_t serial = next_serial(server);
	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface->resource)) continue;
		wl_pointer_send_leave(pointer, serial, surface->resource);
	}
	pointer_send_frame(seat, surface->resource);
}

static void seat_pointer_motion(struct wdc_server *server, int32_t x,
		int32_t y) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->pointer_focus;
	if (!surface) return;

	uint32_t time = now_ms();
	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface->resource)) continue;
		wl_pointer_send_motion(pointer, time, wl_fixed_from_int(x),
			wl_fixed_from_int(y));
	}
	pointer_send_frame(seat, surface->resource);
}

static void seat_pointer_button(struct wdc_server *server, uint32_t button,
		bool pressed) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->pointer_focus;
	if (!surface) return;

	uint32_t serial = next_serial(server);
	uint32_t time = now_ms();
	uint32_t state = pressed ? WL_POINTER_BUTTON_STATE_PRESSED
		: WL_POINTER_BUTTON_STATE_RELEASED;

	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface->resource)) continue;
		wl_pointer_send_button(pointer, serial, time, button, state);
	}
	pointer_send_frame(seat, surface->resource);
}

static void seat_pointer_axis(struct wdc_server *server, uint32_t axis,
		int32_t delta) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->pointer_focus;
	if (!surface) return;

	uint32_t time = now_ms();
	struct wl_resource *pointer;
	wl_resource_for_each(pointer, &seat->pointers) {
		if (!same_client(pointer, surface->resource)) continue;
		int version = wl_resource_get_version(pointer);
		if (version >= WL_POINTER_AXIS_SOURCE_SINCE_VERSION) {
			wl_pointer_send_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
		}
		wl_pointer_send_axis(pointer, time, axis, wl_fixed_from_int(delta));
	}
	pointer_send_frame(seat, surface->resource);
}

/** Modifier state is derived from xkb, never taken from the browser. */
static void seat_send_modifiers(struct wdc_server *server) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->keyboard_focus;
	if (!surface) return;

	uint32_t depressed = xkb_state_serialize_mods(seat->xkb_state,
		XKB_STATE_MODS_DEPRESSED);
	uint32_t latched = xkb_state_serialize_mods(seat->xkb_state,
		XKB_STATE_MODS_LATCHED);
	uint32_t locked = xkb_state_serialize_mods(seat->xkb_state,
		XKB_STATE_MODS_LOCKED);
	uint32_t group = xkb_state_serialize_layout(seat->xkb_state,
		XKB_STATE_LAYOUT_EFFECTIVE);

	uint32_t serial = next_serial(server);
	struct wl_resource *keyboard;
	wl_resource_for_each(keyboard, &seat->keyboards) {
		if (!same_client(keyboard, surface->resource)) continue;
		wl_keyboard_send_modifiers(keyboard, serial, depressed, latched, locked,
			group);
	}
}

static bool pressed_contains(struct wdc_seat *seat, uint32_t key) {
	uint32_t *entry;
	wl_array_for_each(entry, &seat->pressed) {
		if (*entry == key) return true;
	}
	return false;
}

static void pressed_remove(struct wdc_seat *seat, uint32_t key) {
	uint32_t *entries = seat->pressed.data;
	size_t count = seat->pressed.size / sizeof(uint32_t);
	for (size_t i = 0; i < count; i++) {
		if (entries[i] != key) continue;
		memmove(&entries[i], &entries[i + 1],
			(count - i - 1) * sizeof(uint32_t));
		seat->pressed.size -= sizeof(uint32_t);
		return;
	}
}

static void seat_key(struct wdc_server *server, uint32_t key, bool pressed) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->keyboard_focus;
	if (!surface) return;

	/* Ignore a repeat we already know about: the client does its own key
	 * repeat from repeat_info, and a duplicate press would double it. */
	if (pressed == pressed_contains(seat, key)) return;

	if (pressed) {
		uint32_t *entry = wl_array_add(&seat->pressed, sizeof(uint32_t));
		if (entry) *entry = key;
	} else {
		pressed_remove(seat, key);
	}

	uint32_t serial = next_serial(server);
	uint32_t time = now_ms();
	uint32_t state = pressed ? WL_KEYBOARD_KEY_STATE_PRESSED
		: WL_KEYBOARD_KEY_STATE_RELEASED;

	struct wl_resource *keyboard;
	wl_resource_for_each(keyboard, &seat->keyboards) {
		if (!same_client(keyboard, surface->resource)) continue;
		wl_keyboard_send_key(keyboard, serial, time, key, state);
	}

	/* xkb speaks in keycodes, which are evdev codes offset by 8. */
	xkb_state_update_key(seat->xkb_state, key + 8,
		pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
	seat_send_modifiers(server);
}

static void seat_keyboard_enter(struct wdc_server *server,
		struct wdc_surface *surface) {
	struct wdc_seat *seat = &server->seat;
	if (seat->keyboard_focus == surface) return;
	seat->keyboard_focus = surface;

	uint32_t serial = next_serial(server);
	struct wl_resource *keyboard;
	wl_resource_for_each(keyboard, &seat->keyboards) {
		if (!same_client(keyboard, surface->resource)) continue;
		wl_keyboard_send_enter(keyboard, serial, surface->resource,
			&seat->pressed);
	}
	seat_send_modifiers(server);
}

static void seat_keyboard_leave(struct wdc_server *server) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_surface *surface = seat->keyboard_focus;
	if (!surface) return;

	/*
	 * Release everything still held first. Losing focus with a key down —
	 * switching tabs mid-chord — would otherwise leave the application with a
	 * stuck modifier and no way to clear it.
	 */
	while (seat->pressed.size > 0) {
		uint32_t key = *(uint32_t *)seat->pressed.data;
		seat_key(server, key, false);
	}

	uint32_t serial = next_serial(server);
	struct wl_resource *keyboard;
	wl_resource_for_each(keyboard, &seat->keyboards) {
		if (!same_client(keyboard, surface->resource)) continue;
		wl_keyboard_send_leave(keyboard, serial, surface->resource);
	}
	seat->keyboard_focus = NULL;
}

/**
 * Tell the browser which cursor to show. The cursor-shape protocol is
 * deliberately modelled on CSS, so the names line up and the client can turn
 * a shape into a `cursor:` value almost mechanically.
 */
static void seat_send_cursor(struct wdc_server *server, uint32_t shape) {
	struct wdc_seat *seat = &server->seat;
	if (!server->ipc || seat->cursor_shape == shape) return;
	seat->cursor_shape = shape;

	uint8_t msg[4];
	ipc_put_u32(msg, shape);
	ipc_send(server->ipc, IPC_CURSOR, msg, sizeof msg, NULL, 0);
}

/*
 * The older way of setting a cursor: the client hands over a surface holding
 * the image. Rendering that is a whole second pixel path, and every current
 * toolkit prefers cursor-shape-v1 when it is offered — so the useful half of
 * this request is the NULL surface, which means "hide the pointer".
 */
static void pointer_set_cursor(struct wl_client *client,
		struct wl_resource *resource, uint32_t serial,
		struct wl_resource *surface, int32_t hotspot_x, int32_t hotspot_y) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	if (!surface) {
		seat_send_cursor(server, WDC_CURSOR_HIDDEN);
	} else {
		logdbg("client set a cursor surface; falling back to the default");
		seat_send_cursor(server, WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT);
	}
}

static void pointer_release(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static const struct wl_pointer_interface pointer_impl = {
	.set_cursor = pointer_set_cursor,
	.release = pointer_release,
};

static void keyboard_release(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static const struct wl_keyboard_interface keyboard_impl = {
	.release = keyboard_release,
};

static void input_resource_destroy(struct wl_resource *resource) {
	wl_list_remove(wl_resource_get_link(resource));
}

static void seat_get_pointer(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	struct wl_resource *pointer = wl_resource_create(client,
		&wl_pointer_interface, wl_resource_get_version(resource), id);
	if (!pointer) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(pointer, &pointer_impl, server,
		input_resource_destroy);
	wl_list_insert(&server->seat.pointers, wl_resource_get_link(pointer));
}

static void seat_get_keyboard(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	struct wdc_seat *seat = &server->seat;

	struct wl_resource *keyboard = wl_resource_create(client,
		&wl_keyboard_interface, wl_resource_get_version(resource), id);
	if (!keyboard) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(keyboard, &keyboard_impl, server,
		input_resource_destroy);
	wl_list_insert(&seat->keyboards, wl_resource_get_link(keyboard));

	int fd = keymap_fd(seat);
	if (fd < 0) {
		logmsg("could not hand over the keymap: %s", strerror(errno));
		return;
	}
	wl_keyboard_send_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd,
		(uint32_t)seat->keymap_size);
	close(fd);

	if (wl_resource_get_version(keyboard) >=
			WL_KEYBOARD_REPEAT_INFO_SINCE_VERSION) {
		/* The client repeats for itself; the browser's own repeat is
		 * suppressed, so this is the only source. */
		wl_keyboard_send_repeat_info(keyboard, 25, 600);
	}
}

static void seat_get_touch(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	wl_resource_post_error(resource, WL_SEAT_ERROR_MISSING_CAPABILITY,
		"no touch");
}

static void seat_release(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static const struct wl_seat_interface seat_impl = {
	.get_pointer = seat_get_pointer,
	.get_keyboard = seat_get_keyboard,
	.get_touch = seat_get_touch,
	.release = seat_release,
};

static void seat_bind(struct wl_client *client, void *data, uint32_t version,
		uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&wl_seat_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &seat_impl, data, NULL);

	wl_seat_send_capabilities(resource,
		WL_SEAT_CAPABILITY_POINTER | WL_SEAT_CAPABILITY_KEYBOARD);
	if (version >= WL_SEAT_NAME_SINCE_VERSION) {
		wl_seat_send_name(resource, WDC_SEAT_NAME);
	}
}

/* ------------------------------------------------------------------ */
/* wp_cursor_shape_v1                                                  */
/* ------------------------------------------------------------------ */

static void cursor_device_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void cursor_device_set_shape(struct wl_client *client,
		struct wl_resource *resource, uint32_t serial, uint32_t shape) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	if (shape < WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT ||
			shape > WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ALL_RESIZE) {
		wl_resource_post_error(resource,
			WP_CURSOR_SHAPE_DEVICE_V1_ERROR_INVALID_SHAPE,
			"unknown cursor shape %u", shape);
		return;
	}
	seat_send_cursor(server, shape);
}

static const struct wp_cursor_shape_device_v1_interface cursor_device_impl = {
	.destroy = cursor_device_destroy_req,
	.set_shape = cursor_device_set_shape,
};

static void cursor_manager_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void cursor_manager_get_pointer(struct wl_client *client,
		struct wl_resource *resource, uint32_t id,
		struct wl_resource *pointer) {
	struct wl_resource *device = wl_resource_create(client,
		&wp_cursor_shape_device_v1_interface,
		wl_resource_get_version(resource), id);
	if (!device) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(device, &cursor_device_impl,
		wl_resource_get_user_data(resource), NULL);
}

static void cursor_manager_get_tablet_tool(struct wl_client *client,
		struct wl_resource *resource, uint32_t id,
		struct wl_resource *tablet_tool) {
	/* We advertise no tablet, so nothing can reach this. */
	wl_client_post_no_memory(client);
}

static const struct wp_cursor_shape_manager_v1_interface cursor_manager_impl = {
	.destroy = cursor_manager_destroy_req,
	.get_pointer = cursor_manager_get_pointer,
	.get_tablet_tool_v2 = cursor_manager_get_tablet_tool,
};

static void cursor_manager_bind(struct wl_client *client, void *data,
		uint32_t version, uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&wp_cursor_shape_manager_v1_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &cursor_manager_impl, data, NULL);
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/*                                                                     */
/* Wayland hands a selection over as a pipe: we tell the application    */
/* which type we want and it writes the bytes into a file descriptor we */
/* supply. So copying out is an asynchronous read, and pasting in is    */
/* the same thing mirrored.                                             */
/* ------------------------------------------------------------------ */

/** Text types, best first. */
static const char *const TEXT_MIMES[] = {
	"text/plain;charset=utf-8",
	"UTF8_STRING",
	"text/plain",
	"STRING",
};

static bool is_text_mime(const char *mime) {
	for (size_t i = 0; i < sizeof TEXT_MIMES / sizeof TEXT_MIMES[0]; i++) {
		if (strcmp(mime, TEXT_MIMES[i]) == 0) return true;
	}
	return false;
}

static void offer_selection_to_all(struct wdc_server *server);

/* One in-flight read of an application's selection. */
struct wdc_selection_read {
	struct wdc_server *server;
	struct wl_event_source *source;
	int fd;
	char *buf;
	size_t len;
	size_t cap;
};

static void selection_read_finish(struct wdc_selection_read *read_state,
		bool deliver) {
	struct wdc_server *server = read_state->server;

	if (deliver && read_state->len > 0) {
		if (server->ipc) {
			ipc_send(server->ipc, IPC_COPY, read_state->buf, read_state->len,
				NULL, 0);
		}
		logdbg("clipboard: %zu bytes from the application", read_state->len);

	}
	wl_event_source_remove(read_state->source);
	close(read_state->fd);
	free(read_state->buf);
	free(read_state);
}

static int handle_selection_readable(int fd, uint32_t mask, void *data) {
	struct wdc_selection_read *read_state = data;

	for (;;) {
		if (read_state->len + 4096 > read_state->cap) {
			/* A clipboard is text, not a file transfer. */
			if (read_state->cap >= 1u << 20) {
				selection_read_finish(read_state, true);
				return 0;
			}
			size_t cap = read_state->cap ? read_state->cap * 2 : 8192;
			char *buf = realloc(read_state->buf, cap);
			if (!buf) {
				selection_read_finish(read_state, false);
				return 0;
			}
			read_state->buf = buf;
			read_state->cap = cap;
		}

		ssize_t n = read(fd, read_state->buf + read_state->len,
			read_state->cap - read_state->len);
		if (n > 0) {
			read_state->len += (size_t)n;
			continue;
		}
		if (n == 0) {
			selection_read_finish(read_state, true);
			return 0;
		}
		if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
		if (errno == EINTR) continue;
		selection_read_finish(read_state, false);
		return 0;
	}
}

/** Ask the application for its selection as text, and read it in the loop. */
static void selection_pull(struct wdc_server *server,
		struct wl_resource *source, const char *mime) {
	int fds[2];
	if (pipe2(fds, O_CLOEXEC | O_NONBLOCK) != 0) {
		logmsg("clipboard: no pipe: %s", strerror(errno));
		return;
	}

	wl_data_source_send_send(source, mime, fds[1]);
	close(fds[1]);
	/* The application writes when it gets round to it; make sure it sees the
	 * request rather than waiting for our next flush. */
	wl_client_flush(wl_resource_get_client(source));

	struct wdc_selection_read *read_state = calloc(1, sizeof *read_state);
	if (!read_state) {
		close(fds[0]);
		return;
	}
	read_state->server = server;
	read_state->fd = fds[0];
	read_state->source = wl_event_loop_add_fd(server->loop, fds[0],
		WL_EVENT_READABLE, handle_selection_readable, read_state);
	if (!read_state->source) {
		close(fds[0]);
		free(read_state);
	}
}

/* ------------------------------------------------------------------ */
/* wl_subcompositor and wl_data_device_manager                         */
/*                                                                     */
/* Clients bind these unconditionally and fall over if they are absent,*/
/* so they exist and do nothing. A subsurface will not be composited   */
/* in stage 1; a selection will not be carried.                        */
/* ------------------------------------------------------------------ */

static void subsurface_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}
static void subsurface_set_position(struct wl_client *client,
		struct wl_resource *resource, int32_t x, int32_t y) {}
static void subsurface_place_above(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *sibling) {}
static void subsurface_place_below(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *sibling) {}
static void subsurface_set_sync(struct wl_client *client,
		struct wl_resource *resource) {}
static void subsurface_set_desync(struct wl_client *client,
		struct wl_resource *resource) {}

static const struct wl_subsurface_interface subsurface_impl = {
	.destroy = subsurface_destroy_req,
	.set_position = subsurface_set_position,
	.place_above = subsurface_place_above,
	.place_below = subsurface_place_below,
	.set_sync = subsurface_set_sync,
	.set_desync = subsurface_set_desync,
};

static void subcompositor_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void subcompositor_get_subsurface(struct wl_client *client,
		struct wl_resource *resource, uint32_t id,
		struct wl_resource *surface, struct wl_resource *parent) {
	struct wl_resource *sub = wl_resource_create(client,
		&wl_subsurface_interface, wl_resource_get_version(resource), id);
	if (!sub) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(sub, &subsurface_impl, NULL, NULL);
	logdbg("subsurface created — not composited in stage 1");
}

static const struct wl_subcompositor_interface subcompositor_impl = {
	.destroy = subcompositor_destroy_req,
	.get_subsurface = subcompositor_get_subsurface,
};

static void subcompositor_bind(struct wl_client *client, void *data,
		uint32_t version, uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&wl_subcompositor_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &subcompositor_impl, data, NULL);
}

/* What an application is offering. Every type, so the offer we hand back can
 * advertise the same ones; and the best text type, so we can read it out. */
#define WDC_MAX_MIMES 32

struct wdc_data_source {
	struct wdc_server *server;
	struct wl_resource *resource;
	char *mimes[WDC_MAX_MIMES];
	int mime_count;
	char *text_mime;
};

static void data_source_offer(struct wl_client *client,
		struct wl_resource *resource, const char *mime_type) {
	struct wdc_data_source *source = wl_resource_get_user_data(resource);
	if (!source) return;

	if (source->mime_count < WDC_MAX_MIMES) {
		char *copy = strdup(mime_type);
		if (copy) source->mimes[source->mime_count++] = copy;
	}
	/* First match wins, and TEXT_MIMES is in order of preference. */
	if (!source->text_mime && is_text_mime(mime_type)) {
		source->text_mime = strdup(mime_type);
	}
}

static void data_source_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void data_source_set_actions(struct wl_client *client,
		struct wl_resource *resource, uint32_t dnd_actions) {}

static const struct wl_data_source_interface data_source_impl = {
	.offer = data_source_offer,
	.destroy = data_source_destroy_req,
	.set_actions = data_source_set_actions,
};

static void data_source_resource_destroy(struct wl_resource *resource) {
	struct wdc_data_source *source = wl_resource_get_user_data(resource);
	if (!source) return;
	/* The clipboard cannot be owned by a source that no longer exists. */
	if (source->server && source->server->seat.selection_source == resource) {
		source->server->seat.selection_source = NULL;
	}
	for (int i = 0; i < source->mime_count; i++) free(source->mimes[i]);
	free(source->text_mime);
	free(source);
}

/* ---- The browser's clipboard, offered to the application ---------- */

/* An offer is backed either by the application's own source — in which case
 * the file descriptor is handed straight on and never touches us — or by the
 * text the browser gave us. */
struct wdc_offer {
	struct wdc_server *server;
	struct wl_resource *source;
};

static void data_offer_accept(struct wl_client *client,
		struct wl_resource *resource, uint32_t serial, const char *mime_type) {}

/**
 * The application wants the clipboard. It hands us a file descriptor and we
 * write the text into it — the mirror image of reading a selection out.
 */
static void data_offer_receive(struct wl_client *client,
		struct wl_resource *resource, const char *mime_type, int32_t fd) {
	struct wdc_offer *offer = wl_resource_get_user_data(resource);
	if (!offer) {
		close(fd);
		return;
	}
	struct wdc_server *server = offer->server;
	logdbg("clipboard: the application asked for %s", mime_type);

	/* Its own clipboard: splice the descriptor through untouched. */
	if (offer->source) {
		wl_data_source_send_send(offer->source, mime_type, fd);
		wl_client_flush(wl_resource_get_client(offer->source));
		close(fd);
		return;
	}

	const char *text = server && server->seat.offered ? server->seat.offered : "";
	size_t len = strlen(text);
	size_t at = 0;

	while (at < len) {
		ssize_t n = write(fd, text + at, len - at);
		if (n > 0) {
			at += (size_t)n;
			continue;
		}
		if (n < 0 && errno == EINTR) continue;
		/* A reader that is not reading, or has gone: nothing to be done. */
		break;
	}
	close(fd);
}

static void data_offer_destroy_req(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static void data_offer_resource_destroy(struct wl_resource *resource) {
	free(wl_resource_get_user_data(resource));
}

static void data_offer_finish(struct wl_client *client,
		struct wl_resource *resource) {}

static void data_offer_set_actions(struct wl_client *client,
		struct wl_resource *resource, uint32_t dnd_actions,
		uint32_t preferred_action) {}

static const struct wl_data_offer_interface data_offer_impl = {
	.accept = data_offer_accept,
	.receive = data_offer_receive,
	.destroy = data_offer_destroy_req,
	.finish = data_offer_finish,
	.set_actions = data_offer_set_actions,
};

/** Announce the browser's clipboard to one data device. */
/**
 * Announce whatever currently owns the clipboard to one data device.
 *
 * This is also sent back to the application that has just set a selection —
 * echoing its own clipboard to it. That looks redundant and is not: it is how
 * a toolkit learns the compositor accepted the change. Without it GTK stays
 * in a state where it serves its own copy and ignores every later offer.
 */
static void offer_selection_to(struct wdc_server *server,
		struct wl_resource *device) {
	struct wdc_seat *seat = &server->seat;
	struct wdc_data_source *owner = seat->selection_source
		? wl_resource_get_user_data(seat->selection_source) : NULL;
	if (!owner && !seat->offered) return;

	struct wdc_offer *state = calloc(1, sizeof *state);
	if (!state) return;
	state->server = server;
	state->source = owner ? seat->selection_source : NULL;

	struct wl_resource *offer = wl_resource_create(
		wl_resource_get_client(device), &wl_data_offer_interface,
		wl_resource_get_version(device), 0);
	if (!offer) {
		free(state);
		return;
	}
	wl_resource_set_implementation(offer, &data_offer_impl, state,
		data_offer_resource_destroy);

	logdbg("clipboard: offering %s to a data device",
		owner ? "the application's own selection" : "the browser's text");

	wl_data_device_send_data_offer(device, offer);
	if (owner) {
		for (int i = 0; i < owner->mime_count; i++) {
			wl_data_offer_send_offer(offer, owner->mimes[i]);
		}
	} else {
		for (size_t i = 0; i < sizeof TEXT_MIMES / sizeof TEXT_MIMES[0]; i++) {
			wl_data_offer_send_offer(offer, TEXT_MIMES[i]);
		}
	}
	wl_data_device_send_selection(device, offer);
}

static int offer_after_retraction(void *data) {
	struct wdc_server *server = data;
	struct wl_resource *device;
	wl_resource_for_each(device, &server->seat.data_devices) {
		offer_selection_to(server, device);
	}
	return 0;
}

static void offer_selection_to_all(struct wdc_server *server) {
	offer_after_retraction(server);
}

/* ---- wl_data_device ---------------------------------------------- */

static void data_device_start_drag(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *source,
		struct wl_resource *origin, struct wl_resource *icon,
		uint32_t serial) {
	/* Drag and drop between the application and the browser is its own
	 * project; a drag within the application never reaches us. */
}

static void data_device_set_selection(struct wl_client *client,
		struct wl_resource *resource, struct wl_resource *source,
		uint32_t serial) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	if (!source) return;

	/* The application owns the clipboard now; our own text steps aside. */
	server->seat.selection_source = source;
	free(server->seat.offered);
	server->seat.offered = NULL;
	offer_selection_to_all(server);

	struct wdc_data_source *state = wl_resource_get_user_data(source);
	if (!state || !state->text_mime) {
		logdbg("clipboard: the application offered no text type");
		return;
	}
	/* Read a copy for the browser, separately from whatever the application
	 * itself may later ask for. */
	selection_pull(server, source, state->text_mime);
}

static void data_device_release(struct wl_client *client,
		struct wl_resource *resource) {
	wl_resource_destroy(resource);
}

static const struct wl_data_device_interface data_device_impl = {
	.start_drag = data_device_start_drag,
	.set_selection = data_device_set_selection,
	.release = data_device_release,
};

static void ddm_create_data_source(struct wl_client *client,
		struct wl_resource *resource, uint32_t id) {
	struct wdc_data_source *source = calloc(1, sizeof *source);
	if (!source) {
		wl_client_post_no_memory(client);
		return;
	}
	source->server = wl_resource_get_user_data(resource);
	source->resource = wl_resource_create(client, &wl_data_source_interface,
		wl_resource_get_version(resource), id);
	if (!source->resource) {
		free(source);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(source->resource, &data_source_impl, source,
		data_source_resource_destroy);
}

static void ddm_get_data_device(struct wl_client *client,
		struct wl_resource *resource, uint32_t id, struct wl_resource *seat) {
	struct wdc_server *server = wl_resource_get_user_data(resource);
	struct wl_resource *device = wl_resource_create(client,
		&wl_data_device_interface, wl_resource_get_version(resource), id);
	if (!device) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(device, &data_device_impl, server,
		input_resource_destroy);
	wl_list_insert(&server->seat.data_devices, wl_resource_get_link(device));

	/* Whatever the browser already has is available immediately. */
	offer_selection_to(server, device);
}

static const struct wl_data_device_manager_interface ddm_impl = {
	.create_data_source = ddm_create_data_source,
	.get_data_device = ddm_get_data_device,
};

static void ddm_bind(struct wl_client *client, void *data, uint32_t version,
		uint32_t id) {
	struct wl_resource *resource = wl_resource_create(client,
		&wl_data_device_manager_interface, (int)version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &ddm_impl, data, NULL);
}

/* ------------------------------------------------------------------ */
/* The channel to the node server                                      */
/* ------------------------------------------------------------------ */

static struct wdc_xdg_surface *find_window(struct wdc_server *server,
		uint32_t id) {
	struct wdc_xdg_surface *xdg;
	wl_list_for_each(xdg, &server->windows, link) {
		if (xdg->id == id) return xdg;
	}
	return NULL;
}

/** The popup holding a grab, if any: input belongs to it while it is up. */
static struct wdc_popup *grabbing_popup(struct wdc_server *server) {
	struct wdc_popup *popup;
	wl_list_for_each(popup, &server->popups, link) {
		if (popup->grabbed) return popup;
	}
	return NULL;
}

static void handle_ipc_message(uint8_t type, const uint8_t *payload, size_t len,
		void *user) {
	struct wdc_server *server = user;
	struct wdc_xdg_surface *xdg;

	switch (type) {
	case IPC_CONFIGURE: {
		if (len < 12) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (!xdg || !xdg->toplevel) return;
		int32_t w = (int32_t)ipc_get_u32(payload + 4);
		int32_t h = (int32_t)ipc_get_u32(payload + 8);
		/* The size comes from a browser. */
		if (w < 1 || h < 1 || w > 16384 || h > 16384) return;

		/*
		 * Honour what the application said it can be resized to. Asking a
		 * window to be smaller than its minimum just produces one that
		 * overflows the space we gave it, and then we ask again.
		 */
		struct wdc_toplevel *toplevel = xdg->toplevel;
		if (toplevel->min_width && w < toplevel->min_width) {
			w = toplevel->min_width;
		}
		if (toplevel->min_height && h < toplevel->min_height) {
			h = toplevel->min_height;
		}
		if (toplevel->max_width && w > toplevel->max_width) {
			w = toplevel->max_width;
		}
		if (toplevel->max_height && h > toplevel->max_height) {
			h = toplevel->max_height;
		}

		if (w == xdg->cfg_width && h == xdg->cfg_height) return;
		xdg->cfg_width = w;
		xdg->cfg_height = h;
		logdbg("w%u configure %dx%d", xdg->id, w, h);
		toplevel_send_configure(toplevel);
		/* A toplevel configure is only complete with its xdg_surface half. */
		xdg_surface_send_configure(xdg->resource, next_serial(server));
		break;
	}

	case IPC_ACK:
		if (len < 4) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (xdg && xdg->surface) surface_release_frames(xdg->surface);
		break;

	case IPC_CLOSE:
		if (len < 4) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (!xdg) return;
		/* Ask; the application may refuse, or prompt about unsaved work. */
		if (xdg->toplevel) xdg_toplevel_send_close(xdg->toplevel->resource);
		else if (xdg->popup) xdg_popup_send_popup_done(xdg->popup->resource);
		break;

	case IPC_POINTER: {
		if (len < 21) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (!xdg || !xdg->surface) return;
		struct wdc_surface *surface = xdg->surface;

		uint8_t kind = payload[4];
		int32_t x = (int32_t)ipc_get_u32(payload + 5);
		int32_t y = (int32_t)ipc_get_u32(payload + 9);
		uint32_t arg = ipc_get_u32(payload + 13);
		int32_t value = (int32_t)ipc_get_u32(payload + 17);

		/*
		 * The browser measures against the image it was sent, which is the
		 * buffer cropped to the window geometry. Pointer events are
		 * surface-local, and the surface still includes the invisible shadow
		 * margin around that window — so without this offset every click
		 * lands about 25 pixels up and to the left of where it was aimed,
		 * which looks exactly like input being broken.
		 */
		if (xdg->has_geometry) {
			x += xdg->geometry.x;
			y += xdg->geometry.y;
		}

		switch (kind) {
		case IPC_POINTER_ENTER:
			seat_pointer_enter(server, surface, x, y);
			break;
		case IPC_POINTER_MOTION:
			seat_pointer_enter(server, surface, x, y);
			seat_pointer_motion(server, x, y);
			break;
		case IPC_POINTER_LEAVE:
			seat_pointer_leave(server);
			break;
		case IPC_POINTER_BUTTON: {
			/*
			 * A menu holds a grab: clicking anywhere but the menu itself
			 * dismisses it rather than reaching the window underneath. That
			 * click is consumed, exactly as it would be on a real desktop.
			 */
			struct wdc_popup *grab = grabbing_popup(server);
			if (value && grab && grab->xdg != xdg) {
				xdg_popup_send_popup_done(grab->resource);
				logdbg("click outside w%u dismissed it", grab->xdg->id);
				return;
			}
			static const uint32_t buttons[] = {BTN_LEFT, BTN_MIDDLE, BTN_RIGHT};
			if (arg >= sizeof buttons / sizeof buttons[0]) return;
			seat_pointer_enter(server, surface, x, y);
			seat_pointer_button(server, buttons[arg], value != 0);
			break;
		}
		case IPC_POINTER_AXIS:
			seat_pointer_enter(server, surface, x, y);
			seat_pointer_axis(server,
				arg ? WL_POINTER_AXIS_HORIZONTAL_SCROLL
					: WL_POINTER_AXIS_VERTICAL_SCROLL,
				value);
			break;
		default:
			break;
		}
		break;
	}

	case IPC_KEY: {
		if (len < 9) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (!xdg || !xdg->surface) return;
		uint32_t keycode = ipc_get_u32(payload + 4);
		/* Evdev codes only; anything else is a client bug or worse. */
		if (keycode == 0 || keycode > 0x2ff) return;

		/* While a menu is up it owns the keyboard, whatever the browser
		 * thinks is focused — that is what makes Escape close it. */
		struct wdc_popup *grab = grabbing_popup(server);
		struct wdc_surface *target =
			grab && grab->xdg->surface ? grab->xdg->surface : xdg->surface;

		seat_keyboard_enter(server, target);
		seat_key(server, keycode, payload[8] != 0);
		break;
	}

	case IPC_PASTE: {
		char *text = malloc(len + 1);
		if (!text) return;
		memcpy(text, payload, len);
		text[len] = '\0';
		free(server->seat.offered);
		server->seat.offered = text;
		server->seat.selection_source = NULL;
		logdbg("clipboard: %zu bytes from the browser", len);
		offer_selection_to_all(server);
		break;
	}

	case IPC_FOCUS:
		if (len < 5) return;
		xdg = find_window(server, ipc_get_u32(payload));
		if (!xdg || !xdg->surface) return;
		if (payload[4]) {
			seat_keyboard_enter(server, xdg->surface);
		} else {
			seat_keyboard_leave(server);
			seat_pointer_leave(server);
		}
		break;

	default:
		break;
	}
}

static int handle_ipc_readable(int fd, uint32_t mask, void *data) {
	struct wdc_server *server = data;
	if (ipc_read(server->ipc, handle_ipc_message, server) != 0) {
		logmsg("the server closed the channel");
		server->running = false;
	}
	return 0;
}

/*
 * A frame acknowledgement that never arrives — a wedged tab, a dropped
 * socket — would otherwise freeze the application forever, since it is
 * waiting on a frame callback we are holding.
 */
static void release_stale_frames(struct wdc_server *server) {
	uint32_t now = now_ms();
	struct wdc_xdg_surface *xdg;
	wl_list_for_each(xdg, &server->windows, link) {
		if (!xdg->surface) continue;
		struct wdc_surface *surface = xdg->surface;
		if (!surface->awaiting_ack) continue;
		if (now - surface->frame_sent_ms < 2000) continue;
		logdbg("w%u frame not acknowledged in 2s, releasing", xdg->id);
		surface_release_frames(surface);
	}
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

static int handle_signal(int sig, void *data) {
	struct wdc_server *server = data;
	logmsg("caught signal %d, stopping", sig);
	server->running = false;
	return 0;
}

static void spawn_client(struct wdc_server *server, const char *socket_name,
		char **argv, bool force_shm) {
	pid_t pid = fork();
	if (pid < 0) {
		logmsg("fork failed: %s", strerror(errno));
		return;
	}
	if (pid > 0) {
		server->child = pid;
		logmsg("launched %s (pid %d)", argv[0], pid);
		return;
	}

	setenv("WAYLAND_DISPLAY", socket_name, 1);
	/* Leave no X11 fallback for the toolkit to prefer. */
	unsetenv("DISPLAY");
	setenv("GDK_BACKEND", "wayland", 1);
	setenv("QT_QPA_PLATFORM", "wayland", 1);
	if (force_shm) {
		/* Stage 1 can only read shm buffers; push the toolkits off the GPU. */
		setenv("GSK_RENDERER", "cairo", 1);
		setenv("QT_QUICK_BACKEND", "software", 1);
		setenv("LIBGL_ALWAYS_SOFTWARE", "1", 1);
	}

	execvp(argv[0], argv);
	fprintf(stderr, "wdcomp: could not exec %s: %s\n", argv[0], strerror(errno));
	_exit(127);
}

static void usage(FILE *out) {
	fprintf(out,
		"usage: wdcomp [options] [-- command [args...]]\n"
		"\n"
		"A headless Wayland compositor that writes each committed frame to a\n"
		"PNG. Stage 1 of docs/wayland.md — rendering only, no input.\n"
		"\n"
		"  -s, --socket NAME   wayland socket name (default wayland-wd)\n"
		"  -g, --size WxH      size to configure windows at (default 800x600);\n"
		"                      0x0 lets each application choose its own\n"
		"      --scale N       display scale the application draws for (1-3)\n"
		"  -o, --out DIR       where to write frames (default /tmp/wdcomp)\n"
		"  -n, --frames N      exit after N frames (default: run until closed)\n"
		"  -i, --ipc           stream frames over fd 3 instead of writing PNGs\n"
		"  -l, --layout NAME   xkb keyboard layout (default us)\n"
		"      --variant NAME  xkb layout variant\n"
		"      --no-force-shm  do not push the client's toolkit off the GPU\n"
		"  -v, --verbose       log damage rectangles and protocol detail\n"
		"  -h, --help          this\n"
		"\n"
		"  wdcomp -n 1 -- gnome-calculator\n");
}

int main(int argc, char **argv) {
	struct wdc_server server = {
		.width = 800,
		.height = 600,
		.scale = 1,
		.outdir = "/tmp/wdcomp",
		.max_frames = 0,
		.running = true,
	};
	const char *socket_name = "wayland-wd";
	bool force_shm = true;
	bool ipc_mode = false;
	const char *layout = "us";
	const char *variant = NULL;

	static const struct option opts[] = {
		{"socket", required_argument, NULL, 's'},
		{"size", required_argument, NULL, 'g'},
		{"out", required_argument, NULL, 'o'},
		{"frames", required_argument, NULL, 'n'},
		{"ipc", no_argument, NULL, 'i'},
		{"layout", required_argument, NULL, 'l'},
		{"variant", required_argument, NULL, 'V'},
		{"no-force-shm", no_argument, NULL, 'S'},
		/* Long-only: -S is taken, and this is not a thing anyone types twice. */
		{"scale", required_argument, NULL, 'C'},
		{"verbose", no_argument, NULL, 'v'},
		{"help", no_argument, NULL, 'h'},
		{0, 0, 0, 0},
	};

	int c;
	while ((c = getopt_long(argc, argv, "s:g:o:n:il:vh", opts, NULL)) != -1) {
		switch (c) {
		case 's':
			socket_name = optarg;
			break;
		case 'C': {
			char *end = NULL;
			long v = strtol(optarg, &end, 10);
			/* wl_output's scale is an integer by protocol, and past 3 the
			 * buffer costs more than the sharpness is worth. */
			if (!end || *end || v < 1 || v > 3) {
				fprintf(stderr, "wdcomp: --scale takes 1, 2 or 3\n");
				return 2;
			}
			server.scale = (int32_t)v;
			break;
		}
		case 'g':
			if (sscanf(optarg, "%dx%d", &server.width, &server.height) != 2 ||
					server.width < 0 || server.height < 0) {
				logmsg("bad size '%s', expected WxH", optarg);
				return 1;
			}
			break;
		case 'o':
			server.outdir = optarg;
			break;
		case 'n':
			server.max_frames = atoi(optarg);
			break;
		case 'i':
			ipc_mode = true;
			break;
		case 'l':
			layout = optarg;
			break;
		case 'V':
			variant = optarg;
			break;
		case 'S':
			force_shm = false;
			break;
		case 'v':
			wdc_verbose = true;
			break;
		case 'h':
			usage(stdout);
			return 0;
		default:
			usage(stderr);
			return 1;
		}
	}

	signal(SIGPIPE, SIG_IGN);

	if (!ipc_mode && mkdir(server.outdir, 0700) != 0 && errno != EEXIST) {
		logmsg("cannot create %s: %s", server.outdir, strerror(errno));
		return 1;
	}

	server.display = wl_display_create();
	if (!server.display) {
		logmsg("could not create a wayland display");
		return 1;
	}
	server.loop = wl_display_get_event_loop(server.display);
	wl_list_init(&server.windows);
	wl_list_init(&server.popups);

	/*
	 * Clients translate keycodes themselves, so the layout we advertise has to
	 * match the one the person at the browser is really typing on — see
	 * docs/wayland.md.
	 */
	if (!seat_init(&server.seat, layout, variant, NULL)) {
		logmsg("could not set up the seat");
		wl_display_destroy(server.display);
		return 1;
	}

	if (wl_display_add_socket(server.display, socket_name) != 0) {
		logmsg("could not create socket '%s' in %s: %s", socket_name,
			getenv("XDG_RUNTIME_DIR") ? getenv("XDG_RUNTIME_DIR") : "(unset)",
			strerror(errno));
		logmsg("if a previous wdcomp died, remove the stale socket and retry");
		wl_display_destroy(server.display);
		return 1;
	}

	/* libwayland implements wl_shm for us, mmap and pool accounting included. */
	if (wl_display_init_shm(server.display) != 0) {
		logmsg("could not initialise wl_shm");
		wl_display_destroy(server.display);
		return 1;
	}

	wl_global_create(server.display, &wl_compositor_interface, 4, &server,
		compositor_bind);
	wl_global_create(server.display, &wl_subcompositor_interface, 1, &server,
		subcompositor_bind);
	wl_global_create(server.display, &wl_output_interface, 3, &server,
		output_bind);
	wl_global_create(server.display, &wl_seat_interface, 5, &server, seat_bind);
	wl_global_create(server.display, &wl_data_device_manager_interface, 3,
		&server, ddm_bind);
	wl_global_create(server.display, &xdg_wm_base_interface, 3, &server,
		wm_base_bind);
	wl_global_create(server.display, &wp_cursor_shape_manager_v1_interface, 1,
		&server, cursor_manager_bind);

	wl_event_loop_add_signal(server.loop, SIGINT, handle_signal, &server);
	wl_event_loop_add_signal(server.loop, SIGTERM, handle_signal, &server);

	if (ipc_mode) {
		/* Frames go out on stdout; logs stay on stderr, so the pipe carries
		 * nothing but messages. */
		/*
		 * Not stdout: the application and, under dbus-run-session, the bus
		 * daemon share it, and one stray printf would shred the frame
		 * stream. fd 3 is ours alone.
		 */
		server.ipc = ipc_create(WDC_IPC_FD, WDC_IPC_FD);
		if (!server.ipc) {
			logmsg("out of memory");
			wl_display_destroy(server.display);
			return 1;
		}
		if (fcntl(WDC_IPC_FD, F_GETFD) < 0) {
			logmsg("--ipc needs fd %d to be open; the server passes it",
				WDC_IPC_FD);
			wl_display_destroy(server.display);
			return 1;
		}
		int flags = fcntl(WDC_IPC_FD, F_GETFL, 0);
		fcntl(WDC_IPC_FD, F_SETFL, (flags < 0 ? 0 : flags) | O_NONBLOCK);
		wl_event_loop_add_fd(server.loop, WDC_IPC_FD, WL_EVENT_READABLE,
			handle_ipc_readable, &server);
		logmsg("listening on WAYLAND_DISPLAY=%s, streaming frames on fd %d",
			socket_name, WDC_IPC_FD);
	} else {
		logmsg("listening on WAYLAND_DISPLAY=%s, frames to %s", socket_name,
			server.outdir);
	}

	if (optind < argc) {
		spawn_client(&server, socket_name, &argv[optind], force_shm);
	} else {
		logmsg("run a client with: WAYLAND_DISPLAY=%s <command>", socket_name);
	}

	while (server.running) {
		wl_display_flush_clients(server.display);
		if (wl_event_loop_dispatch(server.loop, 100) < 0) {
			logmsg("event loop error: %s", strerror(errno));
			break;
		}
		if (server.ipc) release_stale_frames(&server);
		if (server.child > 0) {
			int status;
			pid_t done = waitpid(server.child, &status, WNOHANG);
			if (done == server.child) {
				logmsg("client exited (status %d)",
					WIFEXITED(status) ? WEXITSTATUS(status) : -1);
				server.child = 0;
				server.running = false;
			}
		}
	}

	/*
	 * Ask the client to go, then insist. A toolkit that ignores SIGTERM —
	 * several do, to run their own shutdown — would otherwise hang us here
	 * forever, and stage 2 has the node server reaping these.
	 */
	if (server.child > 0) {
		kill(server.child, SIGTERM);
		for (int i = 0; i < 30 && server.child > 0; i++) {
			if (waitpid(server.child, NULL, WNOHANG) == server.child) {
				server.child = 0;
				break;
			}
			nanosleep(&(struct timespec){0, 100 * 1000 * 1000}, NULL);
		}
		if (server.child > 0) {
			logmsg("client ignored SIGTERM, killing it");
			kill(server.child, SIGKILL);
			waitpid(server.child, NULL, 0);
		}
	}

	wl_display_destroy(server.display);
	seat_finish(&server.seat);
	ipc_destroy(server.ipc);
	if (ipc_mode) {
		logmsg("%d frame(s) streamed", server.frames_written);
	} else {
		logmsg("%d frame(s) written to %s", server.frames_written,
			server.outdir);
	}
	return server.frames_written > 0 ? 0 : 1;
}
