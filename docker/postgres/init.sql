-- Runs once, the first time the Postgres volume is created.
-- A separate database for automated tests so `pnpm test` never wipes dev data.
CREATE DATABASE payments_test;
