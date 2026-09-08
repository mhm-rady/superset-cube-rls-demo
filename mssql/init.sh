#!/bin/bash
# One-shot init for the containerized SQL Server: restores AdventureWorksDW
# from the backup produced on the host (see README "Data source") and
# creates the dedicated cube_reader login Cube connects with. Runs as its
# own compose service, after `mssql`'s healthcheck passes -- see
# docker-compose.yml's `mssql-init` service.
#
# Idempotent: safe to re-run (e.g. after `docker compose down` without
# `-v`, where the mssql_data volume -- and therefore the restored database
# -- persists and this script has nothing left to do).
set -euo pipefail

SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -S mssql -U sa -P "$MSSQL_SA_PASSWORD" -C -b)

echo "Checking whether AdventureWorksDW already exists..."
EXISTS=$("${SQLCMD[@]}" -h -1 -Q "SET NOCOUNT ON; SELECT CASE WHEN DB_ID('AdventureWorksDW') IS NULL THEN 0 ELSE 1 END" | tr -d '[:space:]')

# The mssql healthcheck only confirms the SERVER is accepting connections
# (SELECT 1 against master) -- after an UNCLEAN shutdown (e.g. the host
# slept, or Docker Desktop was killed) SQL Server runs crash recovery on
# each user database independently, and AdventureWorksDW can still be
# finishing that for a few seconds after the server itself is reachable.
# Confirmed live: `DB_ID('AdventureWorksDW')` above succeeded (it only
# reads the master catalog) while `-d AdventureWorksDW` below failed with
# "Login failed" -- the actual error SQL Server gives for "this database
# isn't ready yet" in this scenario, not a real auth problem. Retry instead
# of failing outright.
wait_for_database_online() {
  local db="$1" attempt
  for attempt in $(seq 1 30); do
    if "${SQLCMD[@]}" -d "$db" -Q "SELECT 1" > /dev/null 2>&1; then
      return 0
    fi
    echo "  $db not ready yet (attempt $attempt/30), retrying in 2s..."
    sleep 2
  done
  echo "  $db did not become ready in time" >&2
  return 1
}

if [ "$EXISTS" != "1" ]; then
  echo "Restoring AdventureWorksDW from /var/opt/mssql/backup/AdventureWorksDW.bak..."
  "${SQLCMD[@]}" -Q "
    RESTORE DATABASE AdventureWorksDW
    FROM DISK = N'/var/opt/mssql/backup/AdventureWorksDW.bak'
    WITH MOVE 'AdventureWorksDW2014_Data' TO '/var/opt/mssql/data/AdventureWorksDW.mdf',
         MOVE 'AdventureWorksDW2014_Log' TO '/var/opt/mssql/data/AdventureWorksDW.ldf',
         REPLACE;
  "
  echo "Restore complete."
else
  echo "AdventureWorksDW already exists -- skipping restore."
fi

echo "Waiting for AdventureWorksDW to be queryable (crash recovery may still be finishing)..."
wait_for_database_online AdventureWorksDW

echo "Ensuring the cube_reader login exists, with db_datareader on AdventureWorksDW only..."
"${SQLCMD[@]}" -Q "
  IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'cube_reader')
  BEGIN
    CREATE LOGIN [cube_reader] WITH PASSWORD = N'$CUBEJS_DB_PASS', CHECK_POLICY = OFF;
  END
"
"${SQLCMD[@]}" -d AdventureWorksDW -Q "
  IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'cube_reader')
  BEGIN
    CREATE USER [cube_reader] FOR LOGIN [cube_reader];
  END
  ALTER ROLE db_datareader ADD MEMBER [cube_reader];
"

echo "mssql-init complete."
