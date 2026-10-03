#ifndef AUG_POSTGRES_ABI_1_H
#define AUG_POSTGRES_ABI_1_H
#include "aug_native.h"
#ifdef __cplusplus
extern "C" {
#endif
AUG_EXPORT int32_t aug_postgres_pool_v1(const void *, uint64_t, int64_t, int64_t, int64_t, void **, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_acquire_v1(void *, void **, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_query_v1(void *, const void *, uint64_t, const void *const *, const uint64_t *, uint64_t, int64_t, int64_t, int64_t, void **, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_rows_v1(const void *, int64_t *, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_null_v1(const void *, int64_t, int64_t, uint8_t *, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_text_v1(const void *, int64_t, int64_t, void **, uint64_t *, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT int32_t aug_postgres_bytes_v1(const void *, int64_t, int64_t, void **, uint64_t *, aug_native_error_v1 *) AUG_NOEXCEPT;
AUG_EXPORT void aug_postgres_buffer_release_v1(void *) AUG_NOEXCEPT;
AUG_EXPORT void aug_postgres_pool_release_v1(void *) AUG_NOEXCEPT;
AUG_EXPORT void aug_postgres_connection_release_v1(void *) AUG_NOEXCEPT;
AUG_EXPORT void aug_postgres_result_release_v1(void *) AUG_NOEXCEPT;
AUG_EXPORT int64_t aug_postgres_live_pools_v1(void) AUG_NOEXCEPT;
AUG_EXPORT int64_t aug_postgres_live_connections_v1(void) AUG_NOEXCEPT;
AUG_EXPORT int64_t aug_postgres_live_results_v1(void) AUG_NOEXCEPT;
#ifdef __cplusplus
}
#endif
#endif
