-- Ledger integrity rules enforced by the database itself.
-- Application code already checks these, but the database is the last line of
-- defence: even a buggy script or a hand-written SQL statement cannot break them.

-- 1. A posting must move money. A zero posting is meaningless noise.
ALTER TABLE "postings" ADD CONSTRAINT "postings_amount_nonzero" CHECK ("amount_kobo" <> 0);

-- 2. Every journal entry must balance (postings sum to zero) and have at least
--    two postings. The check is a DEFERRED constraint trigger: it runs at COMMIT,
--    after all postings of the entry have been inserted, not after each row.
CREATE OR REPLACE FUNCTION ledger_assert_entry_balanced(entry_id uuid) RETURNS void AS $$
DECLARE
  total bigint;
  n int;
BEGIN
  SELECT COALESCE(SUM(amount_kobo), 0), COUNT(*) INTO total, n
  FROM postings WHERE journal_entry_id = entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: journal entry % has % posting(s); at least 2 required', entry_id, n
      USING ERRCODE = '23514';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: journal entry % postings sum to % kobo (must be 0)', entry_id, total
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ledger_check_posting_entry() RETURNS trigger AS $$
BEGIN
  PERFORM ledger_assert_entry_balanced(NEW.journal_entry_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ledger_check_journal_entry() RETURNS trigger AS $$
BEGIN
  PERFORM ledger_assert_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_entry_balanced
  AFTER INSERT ON "postings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_posting_entry();

-- Catches a journal entry inserted with no postings at all.
CREATE CONSTRAINT TRIGGER journal_entries_have_postings
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_journal_entry();

-- 3. Append-only: history is never edited or deleted. Mistakes are corrected
--    with a new, reversing journal entry. (TRUNCATE, used only by the test suite
--    to reset the test database, does not fire row-level triggers.)
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY: % on % is not allowed; post a reversing entry instead', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON "postings"
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
