#include "protocol.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define HOLO_MAGIC 0x484F4C4FU

static uint16_t read_u16(const uint8_t *value) {
    return (uint16_t)(((uint16_t)value[0] << 8U) | value[1]);
}

static uint32_t read_u32(const uint8_t *value) {
    return ((uint32_t)value[0] << 24U) | ((uint32_t)value[1] << 16U) |
        ((uint32_t)value[2] << 8U) | value[3];
}

void holo_u32_write(uint8_t *output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24U);
    output[1] = (uint8_t)(value >> 16U);
    output[2] = (uint8_t)(value >> 8U);
    output[3] = (uint8_t)value;
}

static int read_all(int fd, void *output, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = read(fd, (uint8_t *)output + offset, length - offset);
        if (count > 0) {
            offset += (size_t)count;
        } else if (count == 0) {
            return -1;
        } else if (errno != EINTR) {
            return -1;
        }
    }
    return 0;
}

static int write_all(int fd, const void *input, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(fd, (const uint8_t *)input + offset, length - offset);
        if (count > 0) {
            offset += (size_t)count;
        } else if (count < 0 && errno != EINTR) {
            return -1;
        }
    }
    return 0;
}

void holo_frame_free(struct holo_frame *frame) {
    free(frame->payload);
    memset(frame, 0, sizeof(*frame));
}

int holo_read_frame(int fd, struct holo_frame *frame) {
    uint8_t prefix[4];
    uint8_t *body;
    uint32_t length;
    memset(frame, 0, sizeof(*frame));
    if (read_all(fd, prefix, sizeof(prefix)) != 0) return -1;
    length = read_u32(prefix);
    if (length < HOLO_HEADER_BYTES || length > HOLO_MAX_FRAME_BYTES) return -1;
    body = malloc(length);
    if (body == NULL || read_all(fd, body, length) != 0) {
        free(body);
        return -1;
    }
    if (read_u32(body) != HOLO_MAGIC || body[4] != 1 || read_u16(body + 6) != 0 ||
        body[5] < HOLO_ACK || body[5] > HOLO_FILESYSTEM_RESPONSE) {
        free(body);
        return -1;
    }
    frame->operation = body[5];
    frame->request_id = read_u32(body + 8);
    frame->process_id = read_u32(body + 12);
    frame->sequence = read_u32(body + 16);
    frame->payload_length = length - HOLO_HEADER_BYTES;
    if (frame->payload_length > 0) {
        frame->payload = malloc(frame->payload_length);
        if (frame->payload == NULL) {
            free(body);
            return -1;
        }
        memcpy(frame->payload, body + HOLO_HEADER_BYTES, frame->payload_length);
    }
    free(body);
    return 0;
}

int holo_write_frame(int fd, uint8_t operation, uint32_t request_id, uint32_t process_id,
                     uint32_t sequence, const void *payload, uint32_t payload_length) {
    uint8_t header[4 + HOLO_HEADER_BYTES];
    uint32_t length = HOLO_HEADER_BYTES + payload_length;
    if (length > HOLO_MAX_FRAME_BYTES || operation < HOLO_ACK || operation > HOLO_FILESYSTEM_RESPONSE) return -1;
    holo_u32_write(header, length);
    holo_u32_write(header + 4, HOLO_MAGIC);
    header[8] = 1;
    header[9] = operation;
    header[10] = 0;
    header[11] = 0;
    holo_u32_write(header + 12, request_id);
    holo_u32_write(header + 16, process_id);
    holo_u32_write(header + 20, sequence);
    if (write_all(fd, header, sizeof(header)) != 0) return -1;
    return payload_length == 0 || write_all(fd, payload, payload_length) == 0 ? 0 : -1;
}

int holo_write_empty(int fd, uint8_t operation, uint32_t request_id, uint32_t process_id) {
    return holo_write_frame(fd, operation, request_id, process_id, 0, NULL, 0);
}

int holo_reader_bytes(struct holo_reader *reader, void *output, size_t length) {
    if (reader->offset + length > reader->length) return -1;
    memcpy(output, reader->bytes + reader->offset, length);
    reader->offset += length;
    return 0;
}

int holo_reader_u8(struct holo_reader *reader, uint8_t *output) {
    return holo_reader_bytes(reader, output, 1);
}

int holo_reader_u16(struct holo_reader *reader, uint16_t *output) {
    uint8_t bytes[2];
    if (holo_reader_bytes(reader, bytes, sizeof(bytes)) != 0) return -1;
    *output = read_u16(bytes);
    return 0;
}

int holo_reader_string(struct holo_reader *reader, char **output, uint32_t maximum) {
    uint8_t bytes[4];
    uint32_t length;
    if (holo_reader_bytes(reader, bytes, sizeof(bytes)) != 0) return -1;
    length = read_u32(bytes);
    if (length > maximum || reader->offset + length > reader->length ||
        memchr(reader->bytes + reader->offset, 0, length) != NULL) return -1;
    *output = malloc((size_t)length + 1U);
    if (*output == NULL) return -1;
    memcpy(*output, reader->bytes + reader->offset, length);
    (*output)[length] = 0;
    reader->offset += length;
    return 0;
}

int holo_reader_done(const struct holo_reader *reader) {
    return reader->offset == reader->length ? 0 : -1;
}
