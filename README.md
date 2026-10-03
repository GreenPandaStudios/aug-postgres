# August PostgreSQL

An ordinary August package for PostgreSQL using libpq 18.6 and OpenSSL 3.5.9. Pools, leases and results are owned native resources. One connection keeps a transaction, savepoints and advisory locks on its creating worker. Queries have explicit deadlines, row limits and copied-result byte limits. No package installation runs a build script.

This repository is a release candidate. A retained August compiler/runtime release with the native cancellation probe and matching prebuilt package archives must be published before the following consumer commands are supported:

```sh
aug add https://github.com/GreenPandaStudios/aug-postgres#v0.1.0 --as postgres
aug run
```

Create `NativeDatabaseStorage` and its pool inside the worker, acquire one lease and run parameterized SQL through it. Return copied data, never a `Pool`, `Connection` or `Result`. [tests](tests) contains a complete LLVM consumer. The test connection string uses a disposable database and must be supplied as its first program argument. It verifies bytea, a unique-constraint SQLSTATE, and sibling cancellation while PostgreSQL confirms an active query. [http-tests](http-tests) checks HTTP shutdown while a worker is inside libpq, then verifies that serve returns after joining that worker. Native tests additionally check transactions, savepoints, advisory locks, rollback on release, admission, result bounds, deadlines, cancellation, wrong-thread calls and zero resource counts.

`Pool` maximum is 1–64. A full pool fails immediately with `PostgresError` code -4. Connect and query deadlines are 1–120000 milliseconds; cleanup is 1–30000. Queries contain one statement and up to 4096 non-null text parameters; use explicit SQL casts, with bytea represented by backslash-x followed by `Bytes.hex()`. SQL NULL can be written in SQL and is checked separately in result columns. Copied results are limited to 100000 rows, 256 columns and 64 MiB. The copied-result limit does not bound libpq's internal wire buffer for one field.

Use a single numeric host, Unix socket, or numeric `hostaddr` (comma-separated host lists are rejected) so synchronous DNS cannot bypass the connection budget. For remote TLS use `sslmode=verify-full`, a trusted hostname and an explicit `sslrootcert`. The adapter forces UTF-8 client encoding. Diagnostics omit server text, SQL, parameters and connection strings; `sqlState` returns the five-character server code or an empty string for a client failure.

Deadline, cancellation and result-bound failures discard the connection after bounded cancellation dispatch. Other SQL errors retain transaction affinity for recovery through ROLLBACK TO SAVEPOINT. Releasing a lease rolls back an unfinished transaction before reuse. Disposing a pool closes idle sessions; an existing lease owns an independent reference to internal native pool state and closes on release. No loaned August wrapper or input buffer is retained. Every native resource is released on its creating OS thread.

## Maintainer checks

Run `node native/build.mjs` followed by `node native/ci-server.mjs` in a supported native maintainer environment. The second command builds PostgreSQL 18.6 from the pinned sources, creates a disposable UTF-8 server with SCRAM and test TLS keys, verifies trust rejection and relocatable library loading, then removes the test cluster. Set `AUG_CLI` to the matching source candidate CLI to include the LLVM worker and HTTP drain checks. The candidate workflow builds the pinned August source revision on each target and retains `qualification.json` with the compiler, runtime and exact artifact identities. Publication requires matching native database, LLVM worker and HTTP drain evidence; it rejects missing or mismatched results. It verifies upstream archive digests, builds a static dependency closure and records file hashes, source identity, licenses and runtime inspection. `native/build.json` is an explicit recipe, never an installation hook. Run `aug bind header` against `native/include/aug_postgres.h` and `native.abi.json` with the chosen Clang and target; review its report. Run `native/tests/client.c` against disposable PostgreSQL 18.6 and repeat the August consumer on macOS ARM64 and Debian 12 ARM64/x86-64. Qualify TLS relocation, failure cleanup and public cold installation before advertising a target.

MIT adapter; PostgreSQL License and Apache-2.0 upstream notices are included in each native archive.
