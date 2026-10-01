/**
 * @file 最小 PNG 产生器
 * @description 产生纯色 PNG（封面上传用的假图片），颜色不同 → 内容 hash 不同 → cover_version 不同。
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * @param {[number, number, number]} rgb
 * @param {number} [size]
 */
export function solidPng(rgb, size = 8) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolor
	const row = Buffer.concat([
		Buffer.from([0]),
		...Array.from({ length: size }, () => Buffer.from(rgb)),
	]);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

export const RED_PNG = () => solidPng([220, 30, 30]);
export const BLUE_PNG = () => solidPng([30, 30, 220]);
