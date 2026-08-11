/*
 * ipc.c on its own, without a compositor or an application.
 *
 * There is one thing here worth pinning down, and it cost a long evening: the
 * frame channel is a socketpair the server hands us, and node makes *both*
 * ends non-blocking. A frame bigger than the socket buffer therefore comes
 * back EAGAIN part-written while the reader is alive and about to drain it.
 * The compositor used to call that a broken channel and shut down — which is
 * why Spotify died at its first album cover and the Snap Store at its first
 * screenshot, both a few seconds in, both reported to the browser as a clean
 * exit. Flat GTK windows compress to a few kilobytes and never hit it, so it
 * looked like "some applications" rather than a size threshold.
 *
 * Built and run by `make check-ipc`; listed in tests/run.sh.
 */
#include "ipc.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

/* Comfortably past the 208 kB a Linux unix socket buffers by default. */
#define BODY_BYTES (4u * 1024 * 1024)

static int failures;

static void check(const char *name, int ok, const char *detail) {
	printf("%s  %s", ok ? "PASS" : "FAIL", name);
	if (detail && *detail) printf("  — %s", detail);
	putchar('\n');
	if (!ok) failures++;
}

/*
 * A reader that starts late, then drains everything and reports the total.
 *
 * `sender_fd` is closed in the child before it reads a byte: a fork inherits
 * it, and one stray copy of the sending end is enough that the read side never
 * sees EOF and this hangs instead of finishing.
 */
static pid_t spawn_slow_reader(int fd, int report_fd, int sender_fd, unsigned delay_us) {
	pid_t pid = fork();
	if (pid != 0) return pid;

	close(sender_fd);
	usleep(delay_us);
	size_t total = 0;
	uint8_t buf[65536];
	for (;;) {
		ssize_t n = read(fd, buf, sizeof buf);
		if (n < 0) {
			if (errno == EINTR) continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK) {
				usleep(1000);
				continue;
			}
			break;
		}
		if (n == 0) break;
		total += (size_t)n;
	}
	if (write(report_fd, &total, sizeof total) < 0) _exit(2);
	_exit(0);
}

int main(void) {
	signal(SIGPIPE, SIG_IGN);

	uint8_t *body = malloc(BODY_BYTES);
	if (!body) return 2;
	/* Not a constant fill: a short write that silently dropped a run of
	 * bytes would still add up to the right length. */
	for (size_t i = 0; i < BODY_BYTES; i++) body[i] = (uint8_t)(i * 31u);

	/* ---------------------------------------------------------------- */
	/* A frame larger than the socket buffer                             */
	/* ---------------------------------------------------------------- */
	{
		int fds[2], report[2];
		if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, fds) != 0) return 2;
		if (pipe(report) != 0) return 2;

		/* The reader deliberately does nothing for a moment, so the buffer
		 * is already full when the send starts. */
		pid_t reader = spawn_slow_reader(fds[1], report[1], fds[0], 300000);
		close(fds[1]);
		close(report[1]);

		struct ipc *ipc = ipc_create(fds[0], fds[0]);
		int sent = ipc_send(ipc, 'F', NULL, 0, body, BODY_BYTES);
		check("a frame far larger than the socket buffer is sent, not refused",
			sent == 0, sent == 0 ? "" : "ipc_send reported a broken channel");

		close(fds[0]);
		size_t got = 0;
		if (read(report[0], &got, sizeof got) != (ssize_t)sizeof got) got = 0;
		close(report[0]);
		waitpid(reader, NULL, 0);
		ipc_destroy(ipc);

		/* 4 length bytes and a type byte precede the body. */
		size_t expected = 5 + BODY_BYTES;
		char detail[64];
		snprintf(detail, sizeof detail, "%zu of %zu bytes", got, expected);
		check("and arrives whole at the far end", got == expected, detail);
	}

	/* ---------------------------------------------------------------- */
	/* A reader that has genuinely gone                                  */
	/* ---------------------------------------------------------------- */
	{
		/* Waiting for room must not become waiting forever: a closed peer
		 * has to come back as an error, or the compositor would wedge
		 * instead of shutting down. */
		int fds[2];
		if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, fds) != 0) return 2;
		close(fds[1]);

		struct ipc *ipc = ipc_create(fds[0], fds[0]);
		int sent = ipc_send(ipc, 'F', NULL, 0, body, BODY_BYTES);
		check("a send to a reader that has gone fails instead of waiting",
			sent != 0, sent != 0 ? "" : "ipc_send claimed success");

		int again = ipc_send(ipc, 'F', NULL, 0, body, 16);
		check("and the channel stays broken once it is broken", again != 0, "");

		close(fds[0]);
		ipc_destroy(ipc);
	}

	free(body);
	printf("\n%s\n", failures ? "FAILED" : "ipc: all checks passed");
	return failures ? 1 : 0;
}
