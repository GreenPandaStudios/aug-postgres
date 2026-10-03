// aug-spec: "operations.aug.md" explains this file. Read it before changes; refresh with aug spec.
import Pool and Connection and Result and NativeDatabaseStorage and acquire and query and rows and text and bytes and sqlState and PostgresError from postgres
/** Run inside the worker; no native handle or parent service crosses heaps. */
exercise(string configuration) returns string:
    storage = NativeDatabaseStorage()
    own Pool pool = storage.open(configuration, maximum=1, connectMilliseconds=2000, cleanupMilliseconds=100)
    borrow pool:
        own Connection connection = acquire(pool)
        borrow connection:
            own Result created = query(connection, sql="CREATE TEMP TABLE example (id int PRIMARY KEY, body bytea)", parameters=[], milliseconds=1000, maximumRows=10, maximumBytes=1048576)
            own Result inserted = query(connection, sql="INSERT INTO example VALUES (1, $1::bytea)", parameters=["\\x00017fff80"], milliseconds=1000, maximumRows=10, maximumBytes=1048576)
            own Result result = query(connection, sql="SELECT body FROM example WHERE id=$1::int", parameters=["1"], milliseconds=1000, maximumRows=10, maximumBytes=1048576)
            if rows(result) != 1 or bytes(result, row=0, column=0).hex() != "00017fff80":
                throw PostgresError(code=-1, message="Bytea result differs")
            try:
                own Result duplicate = query(connection, sql="INSERT INTO example VALUES (1, NULL)", parameters=[], milliseconds=1000, maximumRows=10, maximumBytes=1048576)
                throw PostgresError(code=-1, message="Unique constraint was not enforced")
            catch PostgresError error:
                if sqlState(error) != "23505":
                    throw error
    return "PostgreSQL native worker passed"
