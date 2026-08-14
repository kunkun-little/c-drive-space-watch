package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"c-drive-space-watch/internal/model"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;`); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{DB: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	_, _ = db.Exec(`DELETE FROM entries WHERE snapshot_id IN (SELECT id FROM snapshots WHERE status='scanning'); UPDATE snapshots SET status='failed', finished_at=strftime('%s','now')*1000, entry_count=0, file_count=0, dir_count=0, total_size=0, error_message='上次程序退出时扫描尚未完成，未完成索引已清理' WHERE status='scanning'`)
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

func (s *Store) migrate() error {
	_, err := s.DB.Exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  dir_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  record_file_data INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS entries (
  snapshot_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  parent_rel TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mod_time_ns INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  fingerprint INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(snapshot_id, rel_path),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entries_parent_nocase ON entries(snapshot_id, parent_rel COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at DESC);
`)
	if err != nil {
		return err
	}
	if err := ensureSnapshotRecordFileData(s.DB); err != nil {
		return err
	}
	_, err = s.DB.Exec(`DROP INDEX IF EXISTS idx_entries_parent; DROP INDEX IF EXISTS idx_entries_size;`)
	return err
}

func ensureSnapshotRecordFileData(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(snapshots)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	hasColumn := false
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if name == "record_file_data" {
			hasColumn = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if hasColumn {
		return nil
	}
	_, err = db.Exec(`ALTER TABLE snapshots ADD COLUMN record_file_data INTEGER NOT NULL DEFAULT 1`)
	return err
}

func (s *Store) CreateSnapshot(row model.Snapshot) error {
	recordFileData := 0
	if row.RecordFileData {
		recordFileData = 1
	}
	_, err := s.DB.Exec(`INSERT INTO snapshots(id,name,root_path,status,created_at,record_file_data) VALUES(?,?,?,?,?,?)`,
		row.ID, row.Name, row.RootPath, row.Status, row.CreatedAt.UnixMilli(), recordFileData)
	return err
}

func (s *Store) ListSnapshots() ([]model.Snapshot, error) {
	rows, err := s.DB.Query(`SELECT id,name,root_path,status,created_at,finished_at,entry_count,file_count,dir_count,total_size,skipped_count,error_message,record_file_data FROM snapshots ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Snapshot, 0)
	for rows.Next() {
		var r model.Snapshot
		var created int64
		var finished sql.NullInt64
		var recordFileData int
		if err := rows.Scan(&r.ID, &r.Name, &r.RootPath, &r.Status, &created, &finished, &r.EntryCount, &r.FileCount, &r.DirCount, &r.TotalSize, &r.SkippedCount, &r.ErrorMessage, &recordFileData); err != nil {
			return nil, err
		}
		r.RecordFileData = recordFileData == 1
		r.CreatedAt = time.UnixMilli(created)
		if finished.Valid {
			t := time.UnixMilli(finished.Int64)
			r.FinishedAt = &t
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetSnapshot(id string) (model.Snapshot, error) {
	var r model.Snapshot
	var created int64
	var finished sql.NullInt64
	var recordFileData int
	err := s.DB.QueryRow(`SELECT id,name,root_path,status,created_at,finished_at,entry_count,file_count,dir_count,total_size,skipped_count,error_message,record_file_data FROM snapshots WHERE id=?`, id).
		Scan(&r.ID, &r.Name, &r.RootPath, &r.Status, &created, &finished, &r.EntryCount, &r.FileCount, &r.DirCount, &r.TotalSize, &r.SkippedCount, &r.ErrorMessage, &recordFileData)
	if err != nil {
		return r, err
	}
	r.RecordFileData = recordFileData == 1
	r.CreatedAt = time.UnixMilli(created)
	if finished.Valid {
		t := time.UnixMilli(finished.Int64)
		r.FinishedAt = &t
	}
	return r, nil
}

func (s *Store) DeleteSnapshot(id string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	var status string
	if err := tx.QueryRow(`SELECT status FROM snapshots WHERE id=?`, id).Scan(&status); err != nil {
		tx.Rollback()
		return err
	}
	if status == "scanning" {
		tx.Rollback()
		return fmt.Errorf("扫描中的快照不能删除")
	}
	if _, err := tx.Exec(`DELETE FROM entries WHERE snapshot_id=?`, id); err != nil {
		tx.Rollback()
		return err
	}
	if _, err := tx.Exec(`DELETE FROM snapshots WHERE id=?`, id); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) InsertEntries(snapshotID string, entries []model.Entry) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO entries(snapshot_id,rel_path,parent_rel,name,is_dir,size,mod_time_ns,file_count,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, e := range entries {
		isDir := 0
		if e.IsDir {
			isDir = 1
		}
		if _, err := stmt.Exec(snapshotID, e.RelPath, e.ParentRel, e.Name, isDir, e.Size, e.ModTimeNS, e.FileCount, e.Fingerprint); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) UpdateSnapshotProgress(id string, entryCount, fileCount, dirCount, skipped int64) {
	_, _ = s.DB.Exec(`UPDATE snapshots SET entry_count=?,file_count=?,dir_count=?,skipped_count=? WHERE id=? AND status='scanning'`,
		entryCount, fileCount, dirCount, skipped, id)
}

func (s *Store) UpdateDirectoryStats(snapshotID string, sizes map[string]int64, counts map[string]int64, fingerprints map[string]int64) error {
	const batchSize = 2000
	keys := make([]string, 0, len(sizes))
	for rel := range sizes {
		if rel != "" {
			keys = append(keys, rel)
		}
	}
	for start := 0; start < len(keys); start += batchSize {
		end := start + batchSize
		if end > len(keys) {
			end = len(keys)
		}
		tx, err := s.DB.Begin()
		if err != nil {
			return err
		}
		stmt, err := tx.Prepare(`UPDATE entries SET size=?, file_count=?, fingerprint=? WHERE snapshot_id=? AND rel_path=? AND is_dir=1`)
		if err != nil {
			tx.Rollback()
			return err
		}
		for _, rel := range keys[start:end] {
			if _, err := stmt.Exec(sizes[rel], counts[rel], fingerprints[rel], snapshotID, rel); err != nil {
				stmt.Close()
				tx.Rollback()
				return err
			}
		}
		stmt.Close()
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) FinishSnapshot(id string, entryCount, fileCount, dirCount, totalSize, skipped int64) error {
	_, err := s.DB.Exec(`UPDATE snapshots SET status='ready',finished_at=?,entry_count=?,file_count=?,dir_count=?,total_size=?,skipped_count=?,error_message='' WHERE id=?`,
		time.Now().UnixMilli(), entryCount, fileCount, dirCount, totalSize, skipped, id)
	return err
}

func (s *Store) FailSnapshot(id string, cause error, entryCount, fileCount, dirCount, skipped int64) {
	msg := cause.Error()
	tx, err := s.DB.Begin()
	if err != nil {
		return
	}
	_, _ = tx.Exec(`DELETE FROM entries WHERE snapshot_id=?`, id)
	_, _ = tx.Exec(`UPDATE snapshots SET status='failed',finished_at=?,entry_count=?,file_count=?,dir_count=?,total_size=0,skipped_count=?,error_message=? WHERE id=?`,
		time.Now().UnixMilli(), entryCount, fileCount, dirCount, skipped, msg, id)
	_ = tx.Commit()
}

func (s *Store) Children(snapshotID, parentRel string, includeFiles bool) ([]model.Entry, error) {
	query := `SELECT rel_path,parent_rel,name,is_dir,size,mod_time_ns,file_count,fingerprint FROM entries WHERE snapshot_id=? AND parent_rel=? COLLATE NOCASE`
	args := []any{snapshotID, normalizeRel(parentRel)}
	if !includeFiles {
		query += ` AND is_dir=1`
	}
	query += ` ORDER BY is_dir DESC,name COLLATE NOCASE`
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Entry, 0)
	for rows.Next() {
		var e model.Entry
		var isDir int
		if err := rows.Scan(&e.RelPath, &e.ParentRel, &e.Name, &isDir, &e.Size, &e.ModTimeNS, &e.FileCount, &e.Fingerprint); err != nil {
			return nil, err
		}
		e.IsDir = isDir == 1
		out = append(out, e)
	}
	return out, rows.Err()
}

func normalizeRel(v string) string {
	v = strings.TrimSpace(strings.ReplaceAll(v, `\`, "/"))
	v = strings.Trim(v, "/")
	if v == "." {
		return ""
	}
	return v
}
