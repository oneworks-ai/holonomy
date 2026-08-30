#ifndef HOLO_SUPERVISOR_CONFIGURATION_H
#define HOLO_SUPERVISOR_CONFIGURATION_H

#include "protocol.h"

int holo_configuration_apply(int control_fd, const struct holo_frame *frame, uint32_t *exec_gate_timeout_ms);

#endif
