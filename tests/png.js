/*
 * A minimal PNG reader for the icon regression test: 8-bit RGBA/RGB/greyscale,
 * no interlace, which is everything the icon generator writes.
 *
 * The test suite must be able to check "is this icon actually drawn?" without
 * Pillow, so the five scanline filters are implemented here (PNG spec section 9).
 */
"use strict";

var zlib = require("node:zlib");

function paeth(a, b, c) {
	var p = a + b - c;
	var pa = Math.abs(p - a);
	var pb = Math.abs(p - b);
	var pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) {
		return a;
	}
	return pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,channels:number,data:Buffer}} */
function readPng(file) {
	var fs = require("node:fs");
	var buffer = fs.readFileSync(file);
	if (buffer.readUInt32BE(0) !== 0x89504e47) {
		throw new Error(file + ": not a PNG");
	}

	var width = 0;
	var height = 0;
	var channels = 0;
	var bitDepth = 0;
	var chunks = [];

	for (var offset = 8; offset + 8 <= buffer.length; ) {
		var length = buffer.readUInt32BE(offset);
		var type = buffer.toString("ascii", offset + 4, offset + 8);
		var body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			bitDepth = body[8];
			if (body[12] !== 0) {
				throw new Error(file + ": interlaced PNGs are not supported");
			}
			var colorType = body[9];
			channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
			if (!channels) {
				throw new Error(file + ": unsupported colour type " + colorType);
			}
		} else if (type === "IDAT") {
			chunks.push(body);
		}
		offset += 12 + length;
	}

	if (bitDepth !== 8) {
		throw new Error(file + ": expected 8-bit channels, got " + bitDepth);
	}

	var raw = zlib.inflateSync(Buffer.concat(chunks));
	var stride = width * channels;
	var out = Buffer.alloc(height * stride);

	for (var y = 0; y < height; y++) {
		var filter = raw[y * (stride + 1)];
		var line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		var previous = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
		var target = out.subarray(y * stride, (y + 1) * stride);

		for (var x = 0; x < stride; x++) {
			var left = x >= channels ? target[x - channels] : 0;
			var up = previous ? previous[x] : 0;
			var upLeft = previous && x >= channels ? previous[x - channels] : 0;
			var value = line[x];
			if (filter === 1) {
				value += left;
			} else if (filter === 2) {
				value += up;
			} else if (filter === 3) {
				value += (left + up) >> 1;
			} else if (filter === 4) {
				value += paeth(left, up, upLeft);
			}
			target[x] = value & 0xff;
		}
	}

	return { width: width, height: height, channels: channels, data: out };
}

/** The colour of one pixel as `[r, g, b, a]` (alpha 255 when the PNG has none). */
function pixel(png, x, y) {
	var index = (y * png.width + x) * png.channels;
	var r = png.data[index];
	if (png.channels === 1) {
		return [r, r, r, 255];
	}
	if (png.channels === 2) {
		return [r, r, r, png.data[index + 1]];
	}
	var g = png.data[index + 1];
	var b = png.data[index + 2];
	var a = png.channels === 4 ? png.data[index + 3] : 255;
	return [r, g, b, a];
}

/** Pixels that are not (almost) transparent - i.e. pixels the user can see. */
function visiblePixels(png) {
	var count = 0;
	for (var i = 3; i < png.data.length; i += png.channels) {
		if (png.channels < 4 || png.data[i] > 8) {
			count++;
		}
	}
	return count;
}

module.exports = { readPng: readPng, pixel: pixel, visiblePixels: visiblePixels };
