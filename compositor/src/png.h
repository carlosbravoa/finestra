#ifndef WDC_PNG_H
#define WDC_PNG_H

#include <stddef.h>

/*
 * Minimal PNG writer. Stage 1 only: the browser will take raw damage
 * rectangles, not files. This exists so a commit can be looked at.
 *
 * `rgba` is `height` rows of `width` RGBA pixels, `stride` bytes apart.
 * Returns 0 on success.
 */
int png_write_rgba(const char *path, const unsigned char *rgba, int width,
                   int height, int stride);

#endif
