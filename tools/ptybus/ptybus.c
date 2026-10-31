/* LD_PRELOAD shim: modem lines for a pseudo-terminal, so dosbox-x's
 * directserial can be tested on tools/pty_rib.py with a modelled RIB BUSY
 * line. A pty has no modem lines; this answers the modem-line ioctls on pty
 * fds from a small shared-memory block that pty_rib.py also maps:
 *
 *   TIOCMBIS/TIOCMBIC/TIOCMSET  DTR -> shm.dtr (pty_rib sees the PC's BUSY)
 *   TIOCMGET                    CTS|RI = shm.bus (+ an optional stall, as a
 *                               USB adapter's control request takes ~2 ms)
 *   TIOCGICOUNT                 cts/rng = shm.changes (each bus change)
 *   TIOCGSERIAL/TIOCSSERIAL     accepted (low-latency mode)
 *
 * Environment: MOT_PTYBUS=<file> (the shared block, made by pty_rib.py),
 * MOT_PTYBUS_STALL_US=<µs per TIOCMGET> (default 0).
 *
 * Build: cc -shared -fPIC -O2 -o ptybus.so ptybus.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <linux/serial.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

struct bus {                 /* layout shared with pty_rib.py */
	volatile uint32_t dtr;     /* written here: the PC's DTR */
	volatile uint32_t bus;     /* written by pty_rib: BUSY as the PC sees it */
	volatile uint32_t changes; /* written by pty_rib: count of bus changes */
};

static struct bus *shm;
static long stall_us;
static int (*real_ioctl)(int, unsigned long, ...);

static void init(void) {
	if (real_ioctl) return;
	real_ioctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
	const char *path = getenv("MOT_PTYBUS");
	const char *st = getenv("MOT_PTYBUS_STALL_US");
	stall_us = st ? atol(st) : 0;
	if (!path) return;
	int fd = open(path, O_RDWR);
	if (fd < 0) return;
	void *p = mmap(NULL, sizeof(struct bus), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	close(fd);
	if (p != MAP_FAILED) shm = (struct bus *)p;
}

static int is_pty(int fd) {
	struct stat s;
	/* Unix98 pty slaves: majors 136-143 */
	return fstat(fd, &s) == 0 && S_ISCHR(s.st_mode) &&
		major(s.st_rdev) >= 136 && major(s.st_rdev) <= 143;
}

static void stall(void) {
	if (stall_us <= 0) return;
	struct timespec t = { stall_us / 1000000, (stall_us % 1000000) * 1000 };
	nanosleep(&t, NULL);
}

int ioctl(int fd, unsigned long req, ...) {
	va_list ap;
	va_start(ap, req);
	void *arg = va_arg(ap, void *);
	va_end(ap);
	init();
	if (!shm || !is_pty(fd)) return real_ioctl(fd, req, arg);
	switch (req) {
	case TIOCMBIS:
	case TIOCMBIC:
	case TIOCMSET: {
		int f = *(int *)arg;
		stall();
		if (req == TIOCMSET) shm->dtr = (f & TIOCM_DTR) != 0;
		else if (f & TIOCM_DTR) shm->dtr = req == TIOCMBIS;
		return 0;
	}
	case TIOCMGET:
		stall();
		*(int *)arg = (shm->dtr ? TIOCM_DTR : 0) |
			(shm->bus ? TIOCM_CTS | TIOCM_RI : 0);
		return 0;
	case TIOCGICOUNT: {
		struct serial_icounter_struct *ic = (struct serial_icounter_struct *)arg;
		memset(ic, 0, sizeof(*ic));
		ic->cts = ic->rng = (int)shm->changes;
		return 0;
	}
	case TIOCGSERIAL:
		memset(arg, 0, sizeof(struct serial_struct));
		return 0;
	case TIOCSSERIAL:
		return 0;
	}
	return real_ioctl(fd, req, arg);
}
