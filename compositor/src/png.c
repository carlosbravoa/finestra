#include "png.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void be32(unsigned char *p, uint32_t v) {
	p[0] = (unsigned char)(v >> 24);
	p[1] = (unsigned char)(v >> 16);
	p[2] = (unsigned char)(v >> 8);
	p[3] = (unsigned char)v;
}

static int write_chunk(FILE *f, const char *type, const unsigned char *data,
		size_t len) {
	unsigned char hdr[4];
	be32(hdr, (uint32_t)len);
	if (fwrite(hdr, 1, 4, f) != 4) return -1;
	if (fwrite(type, 1, 4, f) != 4) return -1;
	if (len && fwrite(data, 1, len, f) != len) return -1;

	uLong crc = crc32(0L, Z_NULL, 0);
	crc = crc32(crc, (const Bytef *)type, 4);
	if (len) crc = crc32(crc, (const Bytef *)data, (uInt)len);

	unsigned char tail[4];
	be32(tail, (uint32_t)crc);
	return fwrite(tail, 1, 4, f) == 4 ? 0 : -1;
}

int png_write_rgba(const char *path, const unsigned char *rgba, int width,
		int height, int stride) {
	if (width <= 0 || height <= 0) return -1;

	/* Each scanline is prefixed with a filter byte; we always use 0 (none). */
	size_t row = (size_t)width * 4;
	size_t raw_len = (row + 1) * (size_t)height;
	unsigned char *raw = malloc(raw_len);
	if (!raw) return -1;

	for (int y = 0; y < height; y++) {
		unsigned char *dst = raw + (row + 1) * (size_t)y;
		*dst++ = 0;
		memcpy(dst, rgba + (size_t)stride * (size_t)y, row);
	}

	uLongf comp_len = compressBound(raw_len);
	unsigned char *comp = malloc(comp_len);
	if (!comp) {
		free(raw);
		return -1;
	}
	int zerr = compress2(comp, &comp_len, raw, raw_len, Z_DEFAULT_COMPRESSION);
	free(raw);
	if (zerr != Z_OK) {
		free(comp);
		return -1;
	}

	FILE *f = fopen(path, "wb");
	if (!f) {
		free(comp);
		return -1;
	}

	static const unsigned char sig[8] = {137, 'P', 'N', 'G', '\r', '\n', 26, '\n'};
	int rc = fwrite(sig, 1, 8, f) == 8 ? 0 : -1;

	unsigned char ihdr[13];
	be32(ihdr, (uint32_t)width);
	be32(ihdr + 4, (uint32_t)height);
	ihdr[8] = 8;   /* bit depth */
	ihdr[9] = 6;   /* colour type: RGBA */
	ihdr[10] = 0;  /* deflate */
	ihdr[11] = 0;  /* adaptive filtering */
	ihdr[12] = 0;  /* no interlace */

	if (!rc) rc = write_chunk(f, "IHDR", ihdr, sizeof ihdr);
	if (!rc) rc = write_chunk(f, "IDAT", comp, comp_len);
	if (!rc) rc = write_chunk(f, "IEND", NULL, 0);

	free(comp);
	if (fclose(f) != 0) rc = -1;
	if (rc) remove(path);
	return rc;
}
