// aug-spec: "main.aug.md" explains this file. Read it before changes; refresh with aug spec.
import exercise from operations
import blocked and failAfterAdmission from cancellation
try:
    configuration = arguments().get(index=0)
    scope:
        work = start worker exercise(configuration)
        print(value=wait for work)
    try:
        scope:
            sleeping = start worker blocked(configuration)
            failing = start worker failAfterAdmission(configuration)
            wait for failing and sleeping
    catch FileError error:
        print(value="PostgreSQL worker cancellation passed")
catch Error error:
    print(value="PostgreSQL qualification failed")
    exit(status=1)
