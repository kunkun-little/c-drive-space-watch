package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"c-drive-space-watch/internal/config"
	"c-drive-space-watch/internal/db"
	"c-drive-space-watch/internal/model"
	"c-drive-space-watch/internal/scanner"
)

type Server struct {
	store   *db.Store
	cfg     *config.Store
	scanner *scanner.Manager
	webDir  string
}

func New(store *db.Store, cfg *config.Store, scannerMgr *scanner.Manager, webDir string) *Server {
	return &Server{store: store, cfg: cfg, scanner: scannerMgr, webDir: webDir}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.health)
	mux.HandleFunc("/api/config", s.config)
	mux.HandleFunc("/api/system/pick-folder", s.pickFolder)
	mux.HandleFunc("/api/snapshots", s.snapshots)
	mux.HandleFunc("/api/snapshots/", s.snapshotByID)
	mux.HandleFunc("/api/compare", s.compare)
	if s.webDir != "" {
		fs := http.FileServer(http.Dir(s.webDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			path := filepath.Join(s.webDir, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
			if r.URL.Path != "/" {
				if st, err := os.Stat(path); err == nil && !st.IsDir() {
					fs.ServeHTTP(w, r)
					return
				}
			}
			r.URL.Path = "/"
			fs.ServeHTTP(w, r)
		})
	}
	return withJSONHeaders(mux)
}

func withJSONHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, s.cfg.Get())
	case http.MethodPut:
		var cfg config.Config
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeError(w, 400, err)
			return
		}
		if err := s.cfg.Save(cfg); err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, s.cfg.Get())
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) pickFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if runtime.GOOS != "windows" {
		writeError(w, 501, fmt.Errorf("目录选择器仅支持 Windows；请直接输入目录路径"))
		return
	}
	ps := `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择要创建快照的目录'; $d.ShowNewFolderButton=$false; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath}`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-STA", "-Command", ps)
	b, err := cmd.Output()
	if err != nil {
		writeError(w, 500, fmt.Errorf("无法打开目录选择器: %w", err))
		return
	}
	path := strings.TrimSpace(string(b))
	writeJSON(w, 200, map[string]string{"path": path})
}

func (s *Server) snapshots(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, err := s.store.ListSnapshots()
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, rows)
	case http.MethodPost:
		var req struct {
			RootPath string `json:"rootPath"`
			Name     string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, 400, err)
			return
		}
		req.RootPath = strings.TrimSpace(req.RootPath)
		if req.RootPath == "" {
			req.RootPath = s.cfg.Get().DefaultScanRoot
		}
		abs, err := filepath.Abs(req.RootPath)
		if err != nil {
			writeError(w, 400, err)
			return
		}
		if req.Name == "" {
			req.Name = time.Now().Format("2006-01-02 15:04:05")
		}
		cfg := s.cfg.Get()
		row := model.Snapshot{ID: scanner.NewSnapshotID(), Name: req.Name, RootPath: abs, Status: "scanning", RecordFileData: cfg.RecordFileData, CreatedAt: time.Now()}
		if err := s.store.CreateSnapshot(row); err != nil {
			writeError(w, 500, err)
			return
		}
		s.scanner.Start(row, cfg.ExcludePaths, cfg.UseAllocatedSize)
		writeJSON(w, 202, row)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) snapshotByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/snapshots/"), "/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		row, err := s.store.GetSnapshot(id)
		if err != nil {
			if err == sql.ErrNoRows {
				writeError(w, 404, err)
			} else {
				writeError(w, 500, err)
			}
			return
		}
		writeJSON(w, 200, row)
	case http.MethodDelete:
		if err := s.store.DeleteSnapshot(id); err != nil {
			writeError(w, 500, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) compare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	aID, bID := r.URL.Query().Get("a"), r.URL.Query().Get("b")
	parent := normalizeRel(r.URL.Query().Get("path"))
	showUnchanged, _ := strconv.ParseBool(r.URL.Query().Get("showUnchanged"))
	if aID == "" || bID == "" {
		writeError(w, 400, fmt.Errorf("缺少快照 a 或 b"))
		return
	}
	if aID == bID {
		writeError(w, 400, fmt.Errorf("请选择两个不同的快照"))
		return
	}
	aSnap, err := s.store.GetSnapshot(aID)
	if err != nil {
		writeError(w, 404, fmt.Errorf("快照 A 不存在"))
		return
	}
	bSnap, err := s.store.GetSnapshot(bID)
	if err != nil {
		writeError(w, 404, fmt.Errorf("快照 B 不存在"))
		return
	}
	if aSnap.Status != "ready" || bSnap.Status != "ready" {
		writeError(w, 409, fmt.Errorf("只能比较已完成的快照"))
		return
	}
	includeFiles := aSnap.RecordFileData && bSnap.RecordFileData
	aRows, err := s.store.Children(aID, parent, includeFiles)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	bRows, err := s.store.Children(bID, parent, includeFiles)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	merged := merge(aRows, bRows, showUnchanged)
	writeJSON(w, 200, map[string]any{
		"snapshotA": aSnap, "snapshotB": bSnap, "path": parent, "items": merged,
		"summary": map[string]any{"sizeA": aSnap.TotalSize, "sizeB": bSnap.TotalSize, "delta": bSnap.TotalSize - aSnap.TotalSize},
	})
}

func merge(a, b []model.Entry, showUnchanged bool) []model.CompareEntry {
	type pair struct{ a, b *model.Entry }
	m := map[string]*pair{}
	for i := range a {
		k := strings.ToLower(a[i].Name)
		p := m[k]
		if p == nil {
			p = &pair{}
			m[k] = p
		}
		p.a = &a[i]
	}
	for i := range b {
		k := strings.ToLower(b[i].Name)
		p := m[k]
		if p == nil {
			p = &pair{}
			m[k] = p
		}
		p.b = &b[i]
	}
	out := make([]model.CompareEntry, 0, len(m))
	for _, p := range m {
		var x model.CompareEntry
		switch {
		case p.a == nil:
			x = model.CompareEntry{RelPath: p.b.RelPath, Name: p.b.Name, IsDir: p.b.IsDir, Status: "added", SizeB: p.b.Size, Delta: p.b.Size, FileCountB: p.b.FileCount, ModTimeNSB: p.b.ModTimeNS}
		case p.b == nil:
			x = model.CompareEntry{RelPath: p.a.RelPath, Name: p.a.Name, IsDir: p.a.IsDir, Status: "removed", SizeA: p.a.Size, Delta: -p.a.Size, FileCountA: p.a.FileCount, ModTimeNSA: p.a.ModTimeNS}
		default:
			status := "unchanged"
			if p.a.IsDir != p.b.IsDir || p.a.Size != p.b.Size || p.a.FileCount != p.b.FileCount || (p.a.IsDir && p.a.Fingerprint != p.b.Fingerprint) || (!p.a.IsDir && p.a.ModTimeNS != p.b.ModTimeNS) {
				status = "modified"
			}
			x = model.CompareEntry{RelPath: p.b.RelPath, Name: p.b.Name, IsDir: p.b.IsDir, Status: status, SizeA: p.a.Size, SizeB: p.b.Size, Delta: p.b.Size - p.a.Size, FileCountA: p.a.FileCount, FileCountB: p.b.FileCount, ModTimeNSA: p.a.ModTimeNS, ModTimeNSB: p.b.ModTimeNS}
		}
		if showUnchanged || x.Status != "unchanged" {
			out = append(out, x)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		ai, aj := abs64(out[i].Delta), abs64(out[j].Delta)
		if ai != aj {
			return ai > aj
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
func normalizeRel(v string) string {
	v = strings.Trim(strings.ReplaceAll(strings.TrimSpace(v), `\\`, "/"), "/")
	if v == "." {
		return ""
	}
	return v
}
func methodNotAllowed(w http.ResponseWriter) { writeError(w, 405, fmt.Errorf("method not allowed")) }
func writeError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
