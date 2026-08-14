package scanner

import (
	"context"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"c-drive-space-watch/internal/db"
	"c-drive-space-watch/internal/diskusage"
	"c-drive-space-watch/internal/model"
)

type Manager struct {
	store       *db.Store
	mu          sync.Mutex
	scanMu      sync.Mutex
	running     map[string]context.CancelFunc
	autoExclude []string
}

func NewManager(store *db.Store, autoExclude ...string) *Manager {
	return &Manager{store: store, running: map[string]context.CancelFunc{}, autoExclude: autoExclude}
}

func (m *Manager) Start(snapshot model.Snapshot, exclude []string, useAllocatedSize bool) {
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.running[snapshot.ID] = cancel
	m.mu.Unlock()
	go func() {
		defer func() {
			m.mu.Lock()
			delete(m.running, snapshot.ID)
			m.mu.Unlock()
		}()
		m.scanMu.Lock()
		defer m.scanMu.Unlock()
		m.run(ctx, snapshot, exclude, useAllocatedSize)
	}()
}

func (m *Manager) run(ctx context.Context, snapshot model.Snapshot, exclude []string, useAllocatedSize bool) {
	root, err := filepath.Abs(snapshot.RootPath)
	if err != nil {
		m.store.FailSnapshot(snapshot.ID, err, 0, 0, 0, 0)
		return
	}
	info, err := os.Stat(root)
	if err != nil {
		m.store.FailSnapshot(snapshot.ID, err, 0, 0, 0, 0)
		return
	}
	if !info.IsDir() {
		m.store.FailSnapshot(snapshot.ID, fmt.Errorf("扫描路径不是目录: %s", root), 0, 0, 0, 0)
		return
	}

	excluded := normalizeExcluded(append(append([]string{}, exclude...), m.autoExclude...))
	dirSizes := map[string]int64{"": 0}
	dirFiles := map[string]int64{"": 0}
	dirHashes := map[string]uint64{"": 0}
	var entryCount, fileCount, dirCount, skipped int64

	const writeBatchSize = 2000
	batch := make([]model.Entry, 0, writeBatchSize)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := m.store.InsertEntries(snapshot.ID, batch); err != nil {
			return err
		}
		batch = batch[:0]
		m.store.UpdateSnapshotProgress(snapshot.ID, entryCount, fileCount, dirCount, skipped)
		return nil
	}

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if samePath(path, root) {
			return nil
		}
		if isExcluded(path, excluded) {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if walkErr != nil {
			skipped++
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			skipped++
			return nil
		}

		relOS, err := filepath.Rel(root, path)
		if err != nil {
			skipped++
			return nil
		}
		rel := filepath.ToSlash(relOS)
		parent := parentRel(rel)
		inf, err := d.Info()
		if err != nil {
			skipped++
			return nil
		}

		e := model.Entry{
			RelPath:   rel,
			ParentRel: parent,
			Name:      d.Name(),
			IsDir:     d.IsDir(),
			ModTimeNS: inf.ModTime().UnixNano(),
		}
		if d.IsDir() {
			dirCount++
			dirSizes[rel] = 0
			dirFiles[rel] = 0
			dirHashes[rel] = 0
			entryCount++
			batch = append(batch, e)
		} else {
			e.Size = inf.Size()
			if useAllocatedSize {
				e.Size = diskusage.AllocatedSize(path, e.Size)
			}
			e.FileCount = 1
			fileCount++
			dirSizes[parent] += e.Size
			dirFiles[parent]++
			dirHashes[parent] ^= entryHash(e.Name, false, e.Size, e.ModTimeNS, 1, 0)
			if snapshot.RecordFileData {
				entryCount++
				batch = append(batch, e)
			}
		}
		if len(batch) >= writeBatchSize {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	if err != nil {
		m.store.FailSnapshot(snapshot.ID, err, entryCount, fileCount, dirCount, skipped)
		return
	}

	dirs := make([]string, 0, len(dirSizes))
	for rel := range dirSizes {
		dirs = append(dirs, rel)
	}
	sort.Slice(dirs, func(i, j int) bool { return depth(dirs[i]) > depth(dirs[j]) })
	for _, rel := range dirs {
		if rel == "" {
			continue
		}
		p := parentRel(rel)
		dirSizes[p] += dirSizes[rel]
		dirFiles[p] += dirFiles[rel]
		dirHashes[p] ^= entryHash(filepath.Base(filepath.FromSlash(rel)), true, dirSizes[rel], 0, dirFiles[rel], dirHashes[rel])
	}
	dirFingerprints := make(map[string]int64, len(dirHashes))
	for rel, hash := range dirHashes {
		dirFingerprints[rel] = int64(hash)
	}
	if err := m.store.UpdateDirectoryStats(snapshot.ID, dirSizes, dirFiles, dirFingerprints); err != nil {
		m.store.FailSnapshot(snapshot.ID, err, entryCount, fileCount, dirCount, skipped)
		return
	}
	if err := m.store.FinishSnapshot(snapshot.ID, entryCount, fileCount, dirCount, dirSizes[""], skipped); err != nil {
		m.store.FailSnapshot(snapshot.ID, err, entryCount, fileCount, dirCount, skipped)
	}
}

func entryHash(name string, isDir bool, size, modTimeNS, fileCount int64, childHash uint64) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(name))
	if isDir {
		_, _ = h.Write([]byte{1})
	} else {
		_, _ = h.Write([]byte{0})
	}
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uint64(size))
	_, _ = h.Write(buf[:])
	binary.LittleEndian.PutUint64(buf[:], uint64(modTimeNS))
	_, _ = h.Write(buf[:])
	binary.LittleEndian.PutUint64(buf[:], uint64(fileCount))
	_, _ = h.Write(buf[:])
	binary.LittleEndian.PutUint64(buf[:], childHash)
	_, _ = h.Write(buf[:])
	return h.Sum64()
}

func normalizeExcluded(items []string) []string {
	out := make([]string, 0, len(items))
	for _, p := range items {
		if abs, err := filepath.Abs(strings.TrimSpace(p)); err == nil && p != "" {
			out = append(out, strings.ToLower(filepath.Clean(abs)))
		}
	}
	return out
}
func isExcluded(path string, items []string) bool {
	p := strings.ToLower(filepath.Clean(path))
	for _, x := range items {
		if p == x || strings.HasPrefix(p, x+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}
func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
func parentRel(rel string) string {
	p := filepath.ToSlash(filepath.Dir(filepath.FromSlash(rel)))
	if p == "." || p == "/" {
		return ""
	}
	return strings.Trim(p, "/")
}
func depth(rel string) int {
	if rel == "" {
		return 0
	}
	return strings.Count(rel, "/") + 1
}

func NewSnapshotID() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }
