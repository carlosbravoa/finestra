/*
 * xwm — the X window manager inside wdcomp, for Xwayland's clients.
 *
 * Xwayland draws every X window into a wl_surface of its own, but an X window
 * does not say what it is the way an xdg_toplevel does: which surface is
 * which window, its title, whether it is a menu — all of that is X protocol,
 * and answering it is a window manager's job. This file speaks only X; it
 * reports what it learns through callbacks and wdcomp decides what a window
 * becomes. That also keeps libxcb out of the rest of the compositor.
 */
#ifndef WDC_XWM_H
#define WDC_XWM_H

#include <stdbool.h>
#include <stdint.h>

struct xwm;

/* What the window manager knows about one X window when it is reported. */
struct xwm_window {
	uint32_t xwin;
	int32_t x, y, width, height;
	/* Menus, tooltips, drop-downs: placed by the client, never managed. */
	bool override_redirect;
	const char *title;
	const char *app_id;
};

struct xwm_callbacks {
	/* The X window is mapped and drawn into the wl_surface with this id on
	 * Xwayland's connection. Comes again after every remap. */
	void (*surface)(void *data, const struct xwm_window *win, uint32_t surface_id);
	/* Unmapped or destroyed: its surface is no longer a window. */
	void (*gone)(void *data, uint32_t xwin);
	void (*title)(void *data, uint32_t xwin, const char *title);
	void (*geometry)(void *data, uint32_t xwin, int32_t x, int32_t y,
		int32_t width, int32_t height);
};

/* Takes the fd Xwayland was given as -wm; NULL if it is not an X server. */
struct xwm *xwm_create(int fd, const struct xwm_callbacks *cb, void *data);
int xwm_get_fd(struct xwm *xwm);
/* Handles whatever arrived. -1 once the connection is gone. */
int xwm_dispatch(struct xwm *xwm);
void xwm_configure(struct xwm *xwm, uint32_t xwin, int32_t width, int32_t height);
/* WM_DELETE_WINDOW when the client speaks it — the polite close — else kill. */
void xwm_close(struct xwm *xwm, uint32_t xwin);
void xwm_focus(struct xwm *xwm, uint32_t xwin);
void xwm_destroy(struct xwm *xwm);

#endif
