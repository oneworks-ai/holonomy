#include "process-internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HOLO_MAX_ARGS 256
#define HOLO_MAX_ENV 256
#define HOLO_MAX_STRING 4096

static void free_strings(char **values) {
    size_t index;
    if (values == NULL) return;
    for (index = 0; values[index] != NULL; index += 1) free(values[index]);
    free(values);
}

void holo_spawn_request_free(struct holo_spawn_request *request) {
    free(request->path);
    free(request->cwd);
    free(request->executable_id);
    free(request->resource_id);
    free_strings(request->argv);
    free_strings(request->envp);
    memset(request, 0, sizeof(*request));
}

static int parse_args(struct holo_reader *reader, struct holo_spawn_request *request, uint16_t count) {
    uint16_t index;
    request->argv = calloc((size_t)count + 2U, sizeof(char *));
    if (request->argv == NULL) return -1;
    request->argv[0] = strdup(request->path);
    if (request->argv[0] == NULL) return -1;
    for (index = 0; index < count; index += 1) {
        if (holo_reader_string(reader, &request->argv[index + 1U], HOLO_MAX_STRING) != 0) return -1;
    }
    return 0;
}

static int parse_env(struct holo_reader *reader, struct holo_spawn_request *request, uint16_t count) {
    uint16_t index;
    request->envp = calloc((size_t)count + 1U, sizeof(char *));
    if (request->envp == NULL) return -1;
    for (index = 0; index < count; index += 1) {
        char *key = NULL;
        char *value = NULL;
        size_t length;
        if (holo_reader_string(reader, &key, 256) != 0 ||
            holo_reader_string(reader, &value, HOLO_MAX_STRING) != 0 ||
            key[0] == 0 || strchr(key, '=') != NULL) {
            free(key);
            free(value);
            return -1;
        }
        length = strlen(key) + strlen(value) + 2U;
        request->envp[index] = malloc(length);
        if (request->envp[index] == NULL) {
            free(key);
            free(value);
            return -1;
        }
        snprintf(request->envp[index], length, "%s=%s", key, value);
        free(key);
        free(value);
    }
    return 0;
}

int holo_parse_spawn(const struct holo_frame *frame, struct holo_spawn_request *request) {
    struct holo_reader reader = { frame->payload, frame->payload_length, 0 };
    uint8_t version;
    uint8_t reserved[2];
    uint16_t argument_count;
    uint16_t environment_count;
    memset(request, 0, sizeof(*request));
    if (
        holo_reader_u8(&reader, &version) != 0 || version != 1 ||
        holo_reader_u8(&reader, &request->stdio_mask) != 0 || request->stdio_mask > 7 ||
        holo_reader_bytes(&reader, reserved, sizeof(reserved)) != 0 || reserved[0] != 0 || reserved[1] != 0 ||
        holo_reader_string(&reader, &request->path, HOLO_MAX_STRING) != 0 || request->path[0] != '/' ||
        holo_reader_string(&reader, &request->cwd, HOLO_MAX_STRING) != 0 || request->cwd[0] != '/' ||
        holo_reader_string(&reader, &request->executable_id, 128) != 0 ||
        holo_reader_string(&reader, &request->resource_id, 128) != 0 ||
        holo_reader_u16(&reader, &argument_count) != 0 || argument_count > HOLO_MAX_ARGS ||
        holo_reader_u16(&reader, &environment_count) != 0 || environment_count > HOLO_MAX_ENV ||
        parse_args(&reader, request, argument_count) != 0 ||
        parse_env(&reader, request, environment_count) != 0 ||
        holo_reader_done(&reader) != 0
    ) {
        holo_spawn_request_free(request);
        return -1;
    }
    return 0;
}
