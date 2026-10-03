#ifndef AUG_NATIVE_ABI_1_H
#define AUG_NATIVE_ABI_1_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#define AUG_NOEXCEPT noexcept
#else
#define AUG_NOEXCEPT
#endif
#define AUG_EXPORT __attribute__((visibility("default")))
/* No exception or panic may cross this boundary. Message length is <=512.
   Input pointers are call-duration loans; successful owned outputs are released
   only by the matching adapter function. Failed calls initialize outputs. */
/* Available only during the original caller-thread native call. No yielding. */
uint8_t aug_native_cancelled_v1(void) AUG_NOEXCEPT;
typedef struct { int32_t code; uint32_t message_length; unsigned char message[512]; } aug_native_error_v1;
#ifdef __cplusplus
}
#endif
#endif
