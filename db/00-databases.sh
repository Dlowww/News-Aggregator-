#!/bin/bash
# Creates the n8n and dsb databases on first start of the Postgres container.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
  CREATE DATABASE n8n OWNER "$POSTGRES_USER";
  CREATE DATABASE dsb OWNER "$POSTGRES_USER";
SQL
