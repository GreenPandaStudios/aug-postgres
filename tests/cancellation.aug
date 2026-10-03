// aug-spec: "cancellation.aug.md" explains this file. Read it before changes; refresh with aug spec.
import Pool and Connection and Result and NativeDatabaseStorage and acquire and query and text and PostgresError from postgres

/** Wait in libpq until a sibling observes this exact active query and fails. */
blocked(string configuration):
    storage = NativeDatabaseStorage()
    own Pool pool = storage.open(configuration=configuration + " application_name=aug-qualification-blocked", maximum=1, connectMilliseconds=2000, cleanupMilliseconds=100)
    borrow pool:
        own Connection connection = acquire(pool)
        borrow connection:
            own Result result = query(connection, sql="SELECT pg_sleep(5)", parameters=[], milliseconds=6000, maximumRows=1, maximumBytes=4096)
    throw PostgresError(code=-1, message="The blocked query was not cancelled")

/** The failure happens only after PostgreSQL confirms the sibling is waiting. */
failAfterAdmission(string configuration):
    storage = NativeDatabaseStorage()
    own Pool pool = storage.open(configuration, maximum=1, connectMilliseconds=2000, cleanupMilliseconds=100)
    borrow pool:
        own Connection connection = acquire(pool)
        borrow connection:
            attempts = 0
            while attempts < 200:
                own Result result = query(connection, sql="SELECT count(*) FROM pg_stat_activity WHERE application_name='aug-qualification-blocked' AND state='active' AND query='SELECT pg_sleep(5)'", parameters=[], milliseconds=1000, maximumRows=1, maximumBytes=4096)
                if text(result, row=0, column=0) == "1":
                    throw FileError()
                own Result pause = query(connection, sql="SELECT pg_sleep(0.01)", parameters=[], milliseconds=1000, maximumRows=1, maximumBytes=4096)
                attempts = attempts + 1
    throw PostgresError(code=-1, message="The blocked sibling was never observed")
