-- Runs once when the Postgres volume is first created (as superuser).
-- uc_owner: owns schema objects, runs migrations. uc_app: runtime role, DML only, subject to RLS (ADR-002).
-- Development passwords only; production credentials come from a secret manager.
CREATE ROLE uc_owner LOGIN PASSWORD 'uc_owner_dev_pw' CREATEDB;
CREATE ROLE uc_app LOGIN PASSWORD 'uc_app_dev_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE uc_dev OWNER uc_owner;
CREATE DATABASE uc_test OWNER uc_owner;
\connect uc_dev
ALTER SCHEMA public OWNER TO uc_owner;
\connect uc_test
ALTER SCHEMA public OWNER TO uc_owner;
