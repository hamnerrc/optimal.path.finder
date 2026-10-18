// ==========================================================================
// Mapbox Vector Tile decoding (just enough for road lines).
// decodeTileLayer(buffer, layerName) returns { extent, features: [{ props,
// lines: [[x, y, x, y, …], …] }] } for line features of one layer, in tile
// coordinates (0…extent). Other layers are skipped without decoding.
// ==========================================================================

function decodeTileLayer(buffer, layerName) {
    const bytes = new Uint8Array(buffer);
    const reader = new PbfReader(bytes, 0, bytes.length);
    while (reader.more()) {
        const tag = reader.varint();
        if (tag >> 3 === 3 && (tag & 7) === 2) {
            const len = reader.varint();
            const layer = decodeLayer(bytes, reader.pos, reader.pos + len, layerName);
            reader.pos += len;
            if (layer) return layer;
        } else {
            reader.skip(tag & 7);
        }
    }
    return { extent: 4096, features: [] };
}

function decodeLayer(bytes, start, end, wanted) {
    const reader = new PbfReader(bytes, start, end);
    const keys = [], values = [], rawFeatures = [];
    let name = null, extent = 4096;
    while (reader.more()) {
        const tag = reader.varint();
        const field = tag >> 3;
        if (field === 1) {
            name = reader.string();
            if (name !== wanted) return null;
        } else if (field === 2) {
            const len = reader.varint();
            rawFeatures.push([reader.pos, reader.pos + len]);
            reader.pos += len;
        } else if (field === 3) {
            keys.push(reader.string());
        } else if (field === 4) {
            const len = reader.varint();
            values.push(decodeValue(bytes, reader.pos, reader.pos + len));
            reader.pos += len;
        } else if (field === 5) {
            extent = reader.varint();
        } else {
            reader.skip(tag & 7);
        }
    }
    if (name !== wanted) return null;

    const features = [];
    for (const [fStart, fEnd] of rawFeatures) {
        const r = new PbfReader(bytes, fStart, fEnd);
        let type = 0, tags = null, geometry = null;
        while (r.more()) {
            const tag = r.varint();
            const field = tag >> 3;
            if (field === 2) tags = r.packed();
            else if (field === 3) type = r.varint();
            else if (field === 4) geometry = r.packed();
            else r.skip(tag & 7);
        }
        if (type !== 2 || !geometry) continue;
        const props = {};
        if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
        features.push({ props, lines: decodeLines(geometry) });
    }
    return { extent, features };
}

function decodeLines(geometry) {
    const lines = [];
    let x = 0, y = 0, line = null;
    for (let i = 0; i < geometry.length;) {
        const command = geometry[i] & 7;
        const count = geometry[i] >> 3;
        i++;
        if (command === 1 || command === 2) {
            for (let k = 0; k < count; k++) {
                x += zigzag(geometry[i++]);
                y += zigzag(geometry[i++]);
                if (command === 1) {
                    if (line && line.length >= 4) lines.push(line);
                    line = [];
                }
                line.push(x, y);
            }
        }
    }
    if (line && line.length >= 4) lines.push(line);
    return lines;
}

function decodeValue(bytes, start, end) {
    const r = new PbfReader(bytes, start, end);
    let value = null;
    while (r.more()) {
        const tag = r.varint();
        const field = tag >> 3;
        if (field === 1) value = r.string();
        else if (field === 2) { value = new DataView(bytes.buffer, bytes.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
        else if (field === 3) { value = new DataView(bytes.buffer, bytes.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
        else if (field === 4 || field === 5) value = r.varint();
        else if (field === 6) value = zigzag(r.varint());
        else if (field === 7) value = r.varint() !== 0;
        else r.skip(tag & 7);
    }
    return value;
}

const zigzag = (n) => (n >>> 1) ^ -(n & 1);

class PbfReader {
    constructor(bytes, pos, end) {
        this.bytes = bytes;
        this.pos = pos;
        this.end = end;
    }

    more() {
        return this.pos < this.end;
    }

    // Varints above 2^53 (none in road tiles) lose precision.
    varint() {
        let result = 0, shift = 0, b;
        do {
            b = this.bytes[this.pos++];
            result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * Math.pow(2, shift);
            shift += 7;
        } while (b & 0x80);
        return result;
    }

    string() {
        const len = this.varint();
        const s = PbfReader.decoder.decode(this.bytes.subarray(this.pos, this.pos + len));
        this.pos += len;
        return s;
    }

    packed() {
        const end = this.varint() + this.pos;
        const out = [];
        while (this.pos < end) out.push(this.varint());
        return out;
    }

    skip(wireType) {
        if (wireType === 0) this.varint();
        else if (wireType === 1) this.pos += 8;
        else if (wireType === 2) this.pos += this.varint();
        else if (wireType === 5) this.pos += 4;
        else throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
}
PbfReader.decoder = new TextDecoder();

if (typeof module !== "undefined") {
    module.exports = { decodeTileLayer };
}
