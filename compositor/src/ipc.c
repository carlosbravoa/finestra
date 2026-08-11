#include "ipc.h"

#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* A frame of 4K RGBA is ~33 MB; refuse anything an order past that. */
#define IPC_MAX_MESSAGE (64u * 1024 * 1024)

struct ipc {
	int in_fd;
	int out_fd;
	uint8_t *in_buf;
	size_t in_len;
	size_t in_cap;
	int broken;
};

void ipc_put_u32(uint8_t *p, uint32_t v) {
	p[0] = (uint8_t)(v >> 24);
	p[1] = (uint8_t)(v >> 16);
	p[2] = (uint8_t)(v >> 8);
	p[3] = (uint8_t)v;
}

uint32_t ipc_get_u32(const uint8_t *p) {
	return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
		((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

struct ipc *ipc_create(int in_fd, int out_fd) {
	struct ipc *ipc = calloc(1, sizeof *ipc);
	if (!ipc) return NULL;
	ipc->in_fd = in_fd;
	ipc->out_fd = out_fd;
	return ipc;
}

void ipc_destroy(struct ipc *ipc) {
	if (!ipc) return;
	free(ipc->in_buf);
	free(ipc);
}

/*
 * Waiting for room is not optional. The far end is a socketpair the server
 * handed us, and node makes *both* ends of it non-blocking — so a frame bigger
 * than the socket buffer (208 kB by default) comes back EAGAIN part-written,
 * with the reader alive and about to drain it.
 *
 * Calling that a broken channel is what killed every application whose damage
 * did not happen to compress small: Spotify died at its first album cover, the
 * Snap Store at its first screenshot, both a few seconds in and both reported
 * to the browser as a clean exit. Flat GTK windows compress to a few kilobytes
 * and never hit it, which is why this looked like "some applications" rather
 * than a frame-size threshold.
 */
static int write_all(int fd, const void *data, size_t len) {
	const uint8_t *p = data;
	while (len > 0) {
		ssize_t n = write(fd, p, len);
		if (n < 0) {
			if (errno == EINTR) continue;
			if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
			/*
			 * No timeout, which is the flow control the comment below
			 * describes: a browser that cannot keep up should stall the
			 * compositor. A reader that has genuinely gone away closes its
			 * end, and poll reports that as POLLERR/POLLHUP, so this cannot
			 * sit waiting on a socket nobody owns.
			 */
			struct pollfd pfd = { .fd = fd, .events = POLLOUT, .revents = 0 };
			if (poll(&pfd, 1, -1) < 0 && errno != EINTR) return -1;
			continue;
		}
		p += n;
		len -= (size_t)n;
	}
	return 0;
}

/*
 * Writes block, deliberately. A browser that cannot keep up should slow the
 * compositor down, which in turn slows the application down through its frame
 * callbacks — that is the whole flow-control story, and it is better than
 * growing an unbounded queue of stale frames.
 */
int ipc_send(struct ipc *ipc, uint8_t type, const void *head, size_t head_len,
		const void *body, size_t body_len) {
	if (ipc->broken) return -1;

	uint8_t prefix[5];
	uint32_t total = (uint32_t)(1 + head_len + body_len);
	ipc_put_u32(prefix, total);
	prefix[4] = type;

	if (write_all(ipc->out_fd, prefix, sizeof prefix) != 0 ||
			(head_len && write_all(ipc->out_fd, head, head_len) != 0) ||
			(body_len && write_all(ipc->out_fd, body, body_len) != 0)) {
		ipc->broken = 1;
		return -1;
	}
	return 0;
}

static int ensure_capacity(struct ipc *ipc, size_t needed) {
	if (ipc->in_cap >= needed) return 0;
	size_t cap = ipc->in_cap ? ipc->in_cap : 4096;
	while (cap < needed) cap *= 2;
	uint8_t *buf = realloc(ipc->in_buf, cap);
	if (!buf) return -1;
	ipc->in_buf = buf;
	ipc->in_cap = cap;
	return 0;
}

int ipc_read(struct ipc *ipc, ipc_handler handler, void *user) {
	if (ensure_capacity(ipc, ipc->in_len + 65536) != 0) return -1;

	ssize_t n = read(ipc->in_fd, ipc->in_buf + ipc->in_len,
		ipc->in_cap - ipc->in_len);
	if (n == 0) return -1; /* far end closed */
	if (n < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
		return -1;
	}
	ipc->in_len += (size_t)n;

	size_t offset = 0;
	for (;;) {
		if (ipc->in_len - offset < 4) break;
		uint32_t len = ipc_get_u32(ipc->in_buf + offset);
		if (len == 0 || len > IPC_MAX_MESSAGE) return -1;
		if (ipc->in_len - offset < 4 + (size_t)len) break;

		const uint8_t *msg = ipc->in_buf + offset + 4;
		handler(msg[0], msg + 1, len - 1, user);
		offset += 4 + len;
	}

	if (offset > 0) {
		memmove(ipc->in_buf, ipc->in_buf + offset, ipc->in_len - offset);
		ipc->in_len -= offset;
	}
	return 0;
}
