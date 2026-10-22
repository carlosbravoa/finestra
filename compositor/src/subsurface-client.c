/*
 * A Wayland client that draws a window with a subsurface in it, for the test
 * suite: a red toplevel, and a green rectangle committed *synchronized* over
 * it, with an empty input region. It is the shape of Firefox — the browser
 * puts its whole interface in one subsurface — reduced to what the suite can
 * assert on without a browser installed: that the subsurface is announced
 * with its parent and position, that its frame arrives under its own id and
 * only once the parent has committed, and that moving it lands with the
 * parent's next commit.
 *
 * Launched through the service like any application: run.sh writes a desktop
 * entry pointing here. Built only where libwayland-client is, and the suite
 * skips the checks when it is not.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

#include "xdg-shell-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;

static struct wl_surface *surface, *child;
static struct wl_subsurface *subsurface;
static bool running = true;
static int configures;
/* What the output says its density is: a toolkit draws scale times as many
 * pixels into the same logical size, and says so with set_buffer_scale. */
static int32_t scale = 1;

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y,
		int32_t pw, int32_t ph, int32_t sub, const char *make, const char *model,
		int32_t transform) {}
static void output_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w,
		int32_t h, int32_t refresh) {}
static void output_done(void *d, struct wl_output *o) {}
static void output_scale(void *d, struct wl_output *o, int32_t factor) {
	scale = factor;
}
static const struct wl_output_listener output_listener = {
	output_geometry, output_mode, output_done, output_scale, NULL, NULL};

static struct wl_buffer *solid(int32_t w, int32_t h, uint32_t argb) {
	size_t size = (size_t)w * h * 4;
	int fd = memfd_create("wd-subsurface", 0);
	if (fd < 0 || ftruncate(fd, (off_t)size) < 0) {
		perror("memfd");
		exit(1);
	}
	uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	for (size_t i = 0; i < size / 4; i++) px[i] = argb;
	munmap(px, size);
	struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
	struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, w, h, w * 4,
		WL_SHM_FORMAT_ARGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	return buffer;
}

/* Where the compositor says the pointer entered, in surface coordinates,
 * written to the file WD_TEST_POINTER names: the suite sends a click in the
 * browser's pixels and reads back where it landed. */
static void pointer_enter(void *d, struct wl_pointer *p, uint32_t serial,
		struct wl_surface *s, wl_fixed_t sx, wl_fixed_t sy) {
	const char *path = getenv("WD_TEST_POINTER");
	if (!path) return;
	FILE *f = fopen(path, "w");
	if (!f) return;
	fprintf(f, "%s %d %d\n", s == child ? "child" : "window",
		wl_fixed_to_int(sx), wl_fixed_to_int(sy));
	fclose(f);
}
static void pointer_leave(void *d, struct wl_pointer *p, uint32_t serial,
		struct wl_surface *s) {}
static void pointer_motion(void *d, struct wl_pointer *p, uint32_t time,
		wl_fixed_t sx, wl_fixed_t sy) {}
static void pointer_button(void *d, struct wl_pointer *p, uint32_t serial,
		uint32_t time, uint32_t button, uint32_t state) {}
static void pointer_axis(void *d, struct wl_pointer *p, uint32_t time,
		uint32_t axis, wl_fixed_t value) {}
static void pointer_frame(void *d, struct wl_pointer *p) {}
static const struct wl_pointer_listener pointer_listener = {
	pointer_enter, pointer_leave, pointer_motion, pointer_button, pointer_axis,
	pointer_frame, NULL, NULL, NULL, NULL, NULL};

static void seat_capabilities(void *d, struct wl_seat *seat, uint32_t caps) {
	if (caps & WL_SEAT_CAPABILITY_POINTER) {
		wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
	}
}
static void seat_name(void *d, struct wl_seat *seat, const char *name) {}
static const struct wl_seat_listener seat_listener = {seat_capabilities, seat_name};

static void wm_base_ping(void *data, struct xdg_wm_base *base, uint32_t serial) {
	xdg_wm_base_pong(base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {wm_base_ping};

static int32_t width = 320, height = 240;
/* --hide: on the second configure, put the window away — attach nothing and
 * commit, which is how a toolkit hides a window it means to show again —
 * and bring it back a moment later through the handshake xdg-shell asks
 * for. --brief: exit half a second after the first frame, destroying
 * nothing, the way zenity leaves with its dialog up. */
static bool hide, brief;

static void toplevel_configure(void *data, struct xdg_toplevel *toplevel,
		int32_t w, int32_t h, struct wl_array *states) {
	if (w > 0 && h > 0) {
		width = w;
		height = h;
	}
}
static void toplevel_close(void *data, struct xdg_toplevel *toplevel) {
	running = false;
}
static const struct xdg_toplevel_listener toplevel_listener = {
	toplevel_configure, toplevel_close, NULL, NULL};

static void surface_configure(void *data, struct xdg_surface *xdg,
		uint32_t serial) {
	xdg_surface_ack_configure(xdg, serial);
	configures++;

	if (hide && configures == 2) {
		struct wl_display *display = wl_proxy_get_display((struct wl_proxy *)surface);
		wl_surface_attach(surface, NULL, 0, 0);
		wl_surface_commit(surface);
		wl_display_flush(display);
		usleep(300 * 1000);
		/* The initial commit again: no buffer, and a configure to wait for. */
		wl_surface_commit(surface);
		wl_display_flush(display);
		return;
	}

	if (configures == 1) {
		/* The child first, synchronized, and well before the parent: a
		 * compositor that shows it now, rather than with the parent's
		 * commit, is one the suite can catch. */
		child = wl_compositor_create_surface(compositor);
		subsurface = wl_subcompositor_get_subsurface(subcompositor, child, surface);
		wl_subsurface_set_position(subsurface, 40, 30);
		struct wl_region *empty = wl_compositor_create_region(compositor);
		wl_surface_set_input_region(child, empty);
		wl_region_destroy(empty);
		wl_surface_set_buffer_scale(child, scale);
		wl_surface_attach(child, solid(120 * scale, 80 * scale, 0xff00ff00), 0, 0);
		wl_surface_damage_buffer(child, 0, 0, 120 * scale, 80 * scale);
		wl_surface_commit(child);
		wl_display_flush(wl_proxy_get_display((struct wl_proxy *)child));
		usleep(300 * 1000);
	} else {
		/* A move on the child is state of the parent's commit. */
		wl_subsurface_set_position(subsurface, 60, 50);
	}

	wl_surface_set_buffer_scale(surface, scale);
	wl_surface_attach(surface, solid(width * scale, height * scale, 0xffff0000), 0, 0);
	wl_surface_damage_buffer(surface, 0, 0, width * scale, height * scale);
	wl_surface_commit(surface);

	if (brief && configures == 1) {
		wl_display_flush(wl_proxy_get_display((struct wl_proxy *)surface));
		usleep(500 * 1000);
		exit(0);
	}
}
static const struct xdg_surface_listener surface_listener = {surface_configure};

static void global(void *data, struct wl_registry *registry, uint32_t name,
		const char *interface, uint32_t version) {
	if (!strcmp(interface, wl_compositor_interface.name)) {
		compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
	} else if (!strcmp(interface, wl_subcompositor_interface.name)) {
		subcompositor = wl_registry_bind(registry, name, &wl_subcompositor_interface, 1);
	} else if (!strcmp(interface, wl_shm_interface.name)) {
		shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
	} else if (!strcmp(interface, xdg_wm_base_interface.name)) {
		wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
		xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
	} else if (!strcmp(interface, wl_seat_interface.name)) {
		struct wl_seat *seat = wl_registry_bind(registry, name,
			&wl_seat_interface, version < 5 ? version : 5);
		wl_seat_add_listener(seat, &seat_listener, NULL);
	} else if (!strcmp(interface, wl_output_interface.name)) {
		struct wl_output *output = wl_registry_bind(registry, name,
			&wl_output_interface, version < 2 ? version : 2);
		wl_output_add_listener(output, &output_listener, NULL);
	}
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {global, global_remove};

int main(int argc, char **argv) {
	/* An application that does not know about output scale — an X client
	 * through Xwayland, SDL without HiDPI — draws one pixel per logical one
	 * on any screen, and the frame has to say so or the browser shows it at
	 * half size on a 2x one. */
	bool unscaled = false;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--unscaled")) unscaled = true;
		else if (!strcmp(argv[i], "--hide")) hide = true;
		else if (!strcmp(argv[i], "--brief")) brief = true;
	}
	struct wl_display *display = wl_display_connect(NULL);
	if (!display) {
		fprintf(stderr, "wd-subsurface-client: no Wayland display\n");
		return 1;
	}
	struct wl_registry *registry = wl_display_get_registry(display);
	wl_registry_add_listener(registry, &registry_listener, NULL);
	wl_display_roundtrip(display);
	/* The output's scale arrives after the bind; one more round brings it. */
	wl_display_roundtrip(display);
	if (unscaled) scale = 1;
	if (!compositor || !subcompositor || !shm || !wm_base) {
		fprintf(stderr, "wd-subsurface-client: the compositor lacks a global\n");
		return 1;
	}

	surface = wl_compositor_create_surface(compositor);
	struct xdg_surface *xdg = xdg_wm_base_get_xdg_surface(wm_base, surface);
	xdg_surface_add_listener(xdg, &surface_listener, NULL);
	struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xdg);
	xdg_toplevel_add_listener(toplevel, &toplevel_listener, NULL);
	xdg_toplevel_set_title(toplevel, "Subsurface Test");
	xdg_toplevel_set_app_id(toplevel, "wd-subsurface-test");
	wl_surface_commit(surface);

	while (running && wl_display_dispatch(display) != -1) {
	}
	return 0;
}
