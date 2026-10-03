// aug-spec: "work.aug.md" explains this file. Read it before changes; refresh with aug spec.
import Pool and Connection and Result and NativeDatabaseStorage and acquire and query from postgres
/** Resources are created and disposed on the worker; HTTP remains on its event loop. */
block(string configuration):
    storage = NativeDatabaseStorage()
    own Pool pool = storage.open(configuration=configuration + " application_name=aug-qualification-http", maximum=1, connectMilliseconds=2000, cleanupMilliseconds=100)
    borrow pool:
        own Connection connection = acquire(pool)
        borrow connection:
            own Result result = query(connection, sql="SELECT pg_sleep(5)", parameters=[], milliseconds=6000, maximumRows=1, maximumBytes=4096)
